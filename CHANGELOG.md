# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

## [1.36.0] — 2026-10-27

### Added

- **App lock: a master password before HuginnDB shows anything.**
  - Turn it on in **Settings → Security**. Every secret HuginnDB stores moves
    out of the system keychain into an encrypted vault that only the master
    password opens: connection passwords, SSH passwords and passphrases,
    shared-origin passphrases, the AI key and the issue reporter's GitHub
    token. Turning the lock off puts them back exactly as they were.
  - **Nothing behind the wall.** Locked, HuginnDB shows only the lock screen:
    no connections, no restored tabs, no schema tree, and nothing reaches a
    database. The backend refuses every command except unlocking, whatever
    the interface does.
  - **The MCP connector is closed too.** Claude Desktop and other clients get
    "HuginnDB is locked: open the HuginnDB app and unlock it" until you do;
    the connector has no way to open the vault on its own.
  - It locks at every start, after 15 minutes without activity (configurable,
    or never), with **Ctrl+L**, and when the session locks: Win+L, or
    disconnecting from Remote Desktop, which leaves the session running on
    the server (on Linux, logind's session lock). See ADR #119. Locking closes every other window, every
    connection and SSH tunnel, and clears the AI panel's conversation;
    unlocking reconnects nothing.
  - After three wrong passwords each attempt waits longer, up to five minutes.
  - **The lock screen is a padlock in HuginnDB's own sticker style**, animated
    to say what is happening: it snaps shut when the app locks, its three LEDs
    chase while the password is checked, it shakes red on a wrong one, an
    amber ring drains through the wait, and it swings open before the app
    appears. With "reduce motion" on in Windows, it keeps every state and
    drops the movement. A Caps Lock warning sits under the field.
  - **A managed policy can require it.** A role's `appLock` sets `required`
    (HuginnDB opens on a "set a master password" screen and the lock cannot
    be turned off), `maxIdleMinutes` and `lockWithSession`;
    `allowWindowsHello` is accepted and reserved. A policy only ever tightens
    the lock, and a policy that cannot be read keeps the lock that is there.
    Update every installation before adding `appLock`: older ones read the
    field as an invalid policy. See `docs/POLICY.md` and ADR #120.
  - **Settings → Security** gathers it, built like every other section: the
    lock's switch (turning it either way asks for the master password), the
    password change and "Lock now" rows, and the inactivity timeout.
  - **Forgetting the master password loses the secrets in the vault**, and the
    app says so before you turn the lock on. **Forgot your master password?**
    on the lock screen resets the vault: the secrets are deleted, your
    connections stay and ask for their passwords again.
  - It protects against someone at your open Windows session, including one
    who deletes HuginnDB's files. It does not protect against malware or a
    keylogger, and connection names, tab contents and Pulse history are still
    stored unencrypted for now. See the new **App lock** guide and ADR #118.

- **Paste a block of cells into the grid.**
  - Copy several cells from a spreadsheet, another grid or any tab-separated
    text and press Ctrl+V on a cell: the block lands with its top-left cell
    there and spreads right and down, across the columns and rows as they are
    shown. Rows below the last one become **new rows**. One value with no tab
    or line break still pastes into the one cell, as before.
  - Before anything is written, a confirmation says how many cells change and
    how many rows are added, previews the first rows, and names what is left
    out and why: a primary-key column, a column your organization's policy
    locks, a key the database generates. **Paste only the allowed cells** then
    writes the rest. A value equal to what the cell holds is not sent.
  - **All or nothing**: the whole paste is one transaction on PostgreSQL,
    MySQL, SQLite and SQL Server — if one cell fails, nothing changes. On
    MongoDB it is one transaction on a replica set; a standalone server has no
    transactions, so there the writes go in order and stop at the first error,
    and the confirmation says so first. See ADR #114.

- **Managed policy: limit which columns a role may write.**
  - A rule can now say which columns `insert` may give a value to and which
    `update` may change: `"columns": { "insert": ["customer", "amount",
    "status"], "update": ["status"] }`. The people in the role still read the
    whole table; they change only those columns, and their AI never gets more.
    A verb left out of `columns` keeps every column, as before. On MongoDB a
    column is a top-level field.
  - **In the grid**, a column a person can neither change nor fill shows a
    lock in its header, one only a new row may fill shows a "new rows only"
    mark, and the line above the rows names the columns they can change. A locked cell
    still opens, read-only, to read its value; pasting, Set NULL and the bulk
    update leave it out, and a new or duplicated row leaves it to its default.
  - **In the policy editor**, `insert` and `update` each get **All / Only
    these**, with the columns of the rule's own tables to pick from — marked
    when they are required, set by the server, or missing from some table. It
    warns, with a one-click fix, when a required column is left out of
    `insert` (no row could be added) and when `delete` sits beside a limited
    `update` (deleting a row and adding it back would write any column).
    **View as** and Settings → Policy show the columns too.
  - **Generate grants** writes column grants — `GRANT UPDATE (status) ON …` —
    so the database enforces the limits for people with their own database
    user. SQL Server has no column-level `INSERT`, so there the script grants
    `INSERT` on the table and says that `columns.insert` holds only inside
    HuginnDB; MongoDB has no field privileges at all.
  - Under a column limit, free-form `UPDATE`/`INSERT` statements are refused —
    a statement's text does not say which columns its triggers or views write —
    while free-form reads stay as they were.
  - **Update HuginnDB on every computer before adding `columns`**: older
    versions read a policy with it as broken and block every connection. The
    editor says so when you save. See `docs/POLICY.md` and ADR #113.
- **Adding connections with an AI's help, without giving it the keys.** The MCP
  guide (also in **Help → Documentation**) has a new section, *Adding
  connections*, that documents the profile import file well enough for an
  assistant to write one: the `meta` block, the seven required fields, the
  optional ones, and one profile per driver (PostgreSQL, MySQL over an SSH
  tunnel, SQLite, MongoDB from a URI, SQL Server).
  - It is the answer to "can the connector create connections?" — no, on
    purpose. A tool that created them would let the assistant decide where
    HuginnDB connects, and the password would travel through the conversation.
    The assistant writes a file without secrets; you import it with **File →
    Import profiles…**, see what it adds, and type each password in the app.
  - What you import stays local (publishing it to a shared origin is still your
    call) and is not exposed to the MCP connector or the AI panel.
  - A backend test imports every example in both the English and the Spanish
    guide, so the documented format cannot drift from what the importer
    accepts.

### Fixed

- **An SSH tunnel with an RSA key now logs in to current OpenSSH servers.**
  The tunnel always signed with `ssh-rsa`, which uses SHA-1 and which OpenSSH
  8.8 and later refuse by default (`signature algorithm ssh-rsa not in
  PubkeyAcceptedAlgorithms`), so an RSA key was turned away by any up-to-date
  bastion. It now asks the server which signatures it takes, as the OpenSSH
  client does, and signs with `rsa-sha2-512` or `rsa-sha2-256`. `ssh-rsa` is
  used only with a server that takes nothing else. Ed25519 and ECDSA keys were
  never affected.
- **An imported connection is no longer owned by a shared origin from another
  machine.** A profile or environment export carries the id of the shared
  origin each connection came from on the exporting machine, and the import
  kept it. That id names nothing here, so the connection arrived read-only in
  the connection dialog and was reported as belonging to a vanished origin.
  An imported connection is now an ordinary local one, like a connection you
  created yourself; only a shared origin's own sync marks a connection as
  owned by it.

### Security

- **Dependencies brought up to date after a security audit.** The ones that
  ship inside the app:
  - **TLS certificate checks** (every encrypted database connection, the AI
    endpoint and the updater) no longer trust the distrusted emSign (eMudhra)
    intermediate certificates (RUSTSEC-2026-0381/0382/0383), and pick up four
    `rustls` fixes, among them a downgrade of the post-quantum key exchange
    (RUSTSEC-2026-0349) and handshake messages accepted at the wrong stage
    (RUSTSEC-2026-0285).
  - **SQL Server** now uses the same up-to-date TLS stack as every other
    database. Its driver moved to tiberius 0.13, whose old TLS libraries
    no longer received fixes. Queries still run as long as they need: the new
    driver cuts any query at 30 seconds by default, and HuginnDB turns that
    off.
  - **Tauri 2.12**, which fixes a way for one window to read another's IPC
    replies (GHSA-w28w-mhc8-qvjv). HuginnDB's windows only load its own
    interface, so this was not reachable, but the fix is in.
  - **SSH tunnels** moved to russh 0.65, which drops the forked key library
    that carried a `crypto-bigint` with timing side channels
    (RUSTSEC-2026-0387). Saved host-key fingerprints keep matching: a server
    that has an OpenSSH host certificate is still trusted by the key it was
    trusted under before, never by an authority you did not configure. See
    ADR #117. The `rsa` crate's Marvin advisory (RUSTSEC-2023-0071) still
    shows, as it has no fixed version.
- The development toolchain (Vite 8, Vitest 5) clears 25 advisories that only
  affected the machines the app is built on, not the app itself.
- Building HuginnDB from source now declares the Rust version it actually
  needs, 1.90; the dependencies had required it for a while.

## [1.35.0] — 2026-10-22

### Added

- **Batch tools in the MCP connector: several reads, or several writes, in one
  call.**
  - Every tool call is a turn of the AI model, and every turn pays again for
    the conversation so far. An agent that changed a few settings rows one
    `run_write` at a time, and re-read each one to check it, spent most of the
    user's plan on round trips.
  - **`run_queries`** runs a list of read-only statements and returns one
    result per statement, in order. One that fails is reported in its own slot
    and the others still run.
  - **`run_writes`** applies a list of row writes (`INSERT`/`UPDATE`/`DELETE`)
    in **one transaction**: either all of them land or none does. A write can
    say how many rows it must touch (`expect_rows`), and if it touches another
    number the whole batch is rolled back — which catches the `UPDATE` whose
    `WHERE` matched nothing. Reads listed in `verify` run after the commit and
    come back in the same reply, so checking the result costs no extra call.
  - `run_writes` needs the connection's MCP write policy at `data` or above,
    takes up to 50 writes, and refuses schema changes, `BEGIN`/`COMMIT` and
    similar, and an `UPDATE`/`DELETE` with no `WHERE`, saying why. On MongoDB
    the writes run in order with no transaction and stop at the first failure;
    the reply says so.
  - The connector's instructions now tell the AI to batch, so it uses these
    tools without being asked.

### Changed

- **The MCP connector's answers cost fewer tokens.** Every tool used to reply
  with pretty-printed JSON, which puts each cell of a result set on its own
  indented line. An AI client reads that whitespace into its context and the
  user's plan pays for it: a 50-row page came out around 40% larger than it
  needed to be. Replies are now compact JSON, with the same content.

### Fixed

- **A result cut to the MCP connector's `--max-rows` now says it was cut.**
  The rows were dropped but `truncated` stayed `false`, so the AI could not
  tell a page from a whole table. On MongoDB the per-cell types were not cut
  with the rows and stopped lining up with them.

## [1.34.0] — 2026-10-19

### Added

- **A terminal in the bottom dock, with `mongosh` signed in as your MongoDB
  connection.**
  - When you ask an AI tool to check something in MongoDB, it usually answers
    with a `mongosh` script (variables, loops, `printjson`), which the query
    editor refuses: it accepts one statement at a time and no JavaScript. Those
    scripts can now be pasted into `mongosh` inside HuginnDB and run as
    written.
  - The **Terminal** icon in the right activity bar (or `` Mod+Shift+` ``) opens
    it next to the Console. Its **+** menu starts `mongosh` on the current
    MongoDB connection, opened on the database of the tab you were on, or
    your own shell: PowerShell 7 (else Windows PowerShell) on Windows, your
    `$SHELL` (else `bash`) elsewhere. Each session is a tab, and they keep
    running while the dock is collapsed.
  - `mongosh` is offered only while you are on a MongoDB connection that is
    open. With no connection, a SQL one or a closed MongoDB one, the panel
    offers just the shell and says nothing about `mongosh`, not even that it
    is not installed.
  - `mongosh` signs in with the connection's own user, password and SSH
    tunnel, so the connection has to be open first. The password is passed in
    `mongosh`'s environment, never on its command line, and is removed before
    the prompt appears. On Windows it goes straight to the connection's
    prompt, without the question for a connection string that `mongosh` asks
    when it believes it was opened by a double-click. Disconnecting closes the `mongosh` sessions on that
    connection.
  - `mongosh` is not bundled. HuginnDB uses the one you installed, found on
    `PATH` or where the official installers put it; Settings → **Terminal**
    shows which one and its version, and accepts a path.
  - **If there is none, one click downloads it.** On a MongoDB connection with
    no `mongosh` installed, the Terminal's empty state (and its **+** menu, and
    Settings → **Terminal**) offers **Download mongosh**. It fetches the latest
    stable official build for your system from MongoDB's own download site
    (Windows, macOS and Linux, x64 and — except Windows — ARM), checks it
    against the checksum MongoDB publishes, and unpacks it into HuginnDB's own
    data folder; nothing is installed system-wide and no administrator rights
    are needed. It shows progress and can be cancelled. A `mongosh` you
    installed yourself always wins over the downloaded one, and when HuginnDB's
    own copy is the one in use, Settings shows **Update to X** when MongoDB has
    published a newer version.
  - **Under a managed policy it is off unless the role allows it.** A role with
    `"allowToolDownloads": true` may download `mongosh`; without it the button
    is not shown (the Terminal says why) and HuginnDB refuses the request. See
    `docs/POLICY.md`.
  - With the focus in the terminal, shell keys such as `Ctrl+R` or `Ctrl+B`
    reach the shell instead of the app. Copy and paste are
    `Ctrl+Shift+C` / `Ctrl+Shift+V`.
  - Under a managed policy, `mongosh` is only available on connections where
    you may run free-form queries that read and write anything. The plain
    shell is not affected.
- **Pulse and the AI panel can be hidden.**
  - Settings → Pulse has a new **Enable Pulse** switch, on by default. Off
    removes Pulse from the activity bar, the View menu, the command palette
    and its shortcut, and stops the background sampler. The connections you
    had opted in are kept for when you turn it back on.
  - The AI panel's existing switch now hides its icon too while it is off.
  - The terminal has the same switch, in Settings → Terminal; off also
    closes every open session.

### Changed

- **Empty screens are easier to read.** The halftone dots used to cover the
  whole panel and ran under the title and the hint; in a short, wide panel
  such as the Terminal they stretched into a flat band of dots. They are now
  a fainter, round halo behind the logo only, the same in every panel and on
  the start screen. A reason something cannot be done (`mongosh` not found,
  a policy that does not allow it) now appears in its own box under the
  message instead of replacing the hint.
- **The Schema panel stays responsive however many tables a database has.**
  Opening a section with 10,000 tables used to mount all 10,000 rows at
  once, each with its own context menu, and the panel froze. The tree is now
  one virtualised list from folders down to columns, and only the rows near
  the viewport exist at any time. It looks and behaves as before:
  - same guides, menus and filter;
  - the arrow keys still move between connection rows, scrolling to one that
    is far away;
  - an expanded database far down the list still opens its pool on launch, so
    its saved tabs come back.
- **A database with thousands of tables shows its table list right away.**
  Row counts and sizes now arrive a moment after the names on every driver,
  instead of only on MongoDB. Reading them is the part that grows with the
  table count: SQL Server's partition statistics, a `stat` of every file on
  PostgreSQL, `SHOW TABLE STATUS` on MySQL (which opens every table on 5.7),
  and one `dbstat` query *per table* on SQLite, now a single aggregate. On a
  SQL Server database with over 10,000 tables, all of that ran before the tree
  could show anything, and it counted against the operation timeout. Each
  listing now uses the cheapest catalog read its engine has (`sys.objects`,
  `information_schema.tables`, `SHOW FULL TABLES`, `sqlite_master`). The MCP
  connector's `list_tables`, the dump's progress estimate and the AI panel
  still get the figures with the names, from the same two reads.
- **The status bar's console button switches to the Console when the
  Terminal is showing**, instead of closing the dock.
- **The internal "hard-earned gotchas" are now filed as ADRs, gotchas and
  conventions** under `engineering/` (previously `adr/`). Read one at a time,
  85 of the 107 entries were decisions with alternatives, 9 were house rules,
  and 13 were gotchas in the strict sense: facts about a dependency that no
  design of ours can change. Each kind is retired differently. A decision is
  superseded by a newer ADR, a gotcha goes obsolete when the dependency fixes
  it, and a convention is edited in place. Each entry now carries front matter
  (type, status, original date recovered from `CLAUDE.md`'s history, tags,
  related / supersedes / amends), and ADRs open with their decision and the
  alternatives the body records as rejected. Numbers stay one global sequence,
  so every existing `#N` citation still resolves. Code comments and docs now
  name the kind (`ADR #54`, `gotcha #19`, `convention #28`).
  `node scripts/engineering-index.mjs` regenerates the four indexes from the
  front matter (`--check` reports a stale one). Documentation only: no
  behaviour changes.
- **ADR #24 and ADR #81 no longer describe surfaces that are gone.** Each
  gains a dated addendum. #24's sidecar warning has gone through
  `confirmIrreversible` and the in-app `ConfirmHost` since 1.23.0, not
  `window.confirm`. #81's filter conditions moved from the deleted
  advanced-filter dialog to the query panel and the bulk-update dialog in
  1.28.0, and the fixed suggestion panel's containing block is now the
  viewport. Neither decision changed.

### Fixed

- **Connecting through an SSH server that did not answer could hang for
  good.**
  - If the SSH server accepted the connection and then never answered (an
    overloaded server, or a firewall that holds connections instead of
    refusing them), HuginnDB waited forever on "Connecting…".
  - When it happened while a tunnel was reconnecting by itself, every query
    on that connection waited behind it, and then each one tried to log in to
    the server again.
  - Opening the SSH session now gives up after 15 seconds and says which SSH
    server did not answer.
- **An SSH tunnel could keep more than one session open on the server.**
  - When a server was slow to open a connection through the tunnel, HuginnDB
    took the SSH session for dead and logged in again, even though the session
    was still working. The old session was not closed either: it stayed open
    on the server for as long as any database connection was using it, up to
    half an hour.
  - On servers that allow only a few SSH sessions at once, those leftover
    sessions could use up the allowance.
  - A slow connection is now reported as slow, and HuginnDB only logs in again
    when the session really is gone. When it does, it closes the old session
    first.
- **A lost SSH tunnel kept logging in to the server again and again.**
  - When a tunnel's session dropped and logging in again failed, every
    connection using it tried again on its own: the connection check, Pulse,
    MongoDB, each query. A server that bans addresses after repeated SSH logins
    saw a steady stream of them, so the ban could last as long as HuginnDB stayed
    open.
  - After a failed attempt the tunnel now waits before trying again: 5 seconds
    at first, doubling up to 5 minutes. Meanwhile queries fail straight away and
    say when the next attempt will be. Reconnecting by hand still tries at
    once.
- **The MCP connector could open the same connection several times at once.**
  - When the AI ran several tools together and the connector was working
    without the HuginnDB app, each tool opened its own connection to the
    server. Through an SSH tunnel that meant several SSH logins to the same
    server within a second, which servers that limit new SSH connections per
    minute can treat as an attack and block.
  - The tools now wait for the first one to open the connection and share it,
    as the app itself has done since 1.32.0.

## [1.33.0] — 2026-10-14

### Fixed

- **The MCP connector stopped working on Linux every time an AppImage was
  closed.**
  - An AppImage runs from a temporary folder (`/tmp/.mount_Huginn…`) that gets
    a new name on every launch and disappears when the app closes. Settings →
    MCP, and the **Add to Claude Code** button, registered the connector at
    that temporary path, so the AI client lost it as soon as HuginnDB was
    closed or restarted.
  - From an AppImage, clients are now pointed at the `.AppImage` file itself
    with `--mcp` (`HuginnDB.AppImage --mcp`), which starts the connector inside
    the image. That path survives restarts and updates. Other install types
    are unchanged.
  - If you had already registered it, Settings → MCP now says that Claude Code
    points at a path that no longer exists, and **Update registration**
    replaces it, keeping any arguments you had added (`--connections`,
    `--read-only`). Before, **Add to Claude Code** only answered that it was
    already registered.
- **The MCP connector kept using a connection's old settings after you edited
  it.**
  - Pointing a saved connection at another database (or host, or user) in
    HuginnDB did not reach a connector that was already running. It kept
    querying the old database until the AI client was restarted, even after
    an idle period, because it reopened from the settings it had read at
    startup.
  - The connector now reads the connection's current settings on every call,
    and reopens a connection that was edited since it was opened.
  - With the bridge on, a connection the connector opened through the app is
    reopened the same way. If the connection is open in a HuginnDB window, the
    connector asks you to reconnect it there instead of closing it under your
    tabs.
- **Editing an open connection did not take effect until you reconnected it,
  and nothing said so.**
  - Pointing a connection that was open at another database (or host, user,
    SSL setting or SSH tunnel) left the tree, the tabs and every query on the
    old one.
  - Such a connection is now marked in amber in the connection list and the
    status bar, in every window, with a one-click **Reconnect**. It is not
    closed for you, so a running query or unsaved grid edits are not lost.
  - **Connect** in the connection dialog, after an edit, now reconnects.
    Before, it reused the open session with the old settings.

## [1.32.0] — 2026-10-08

### Added

- **The documentation viewer is rebuilt to match Preferences.**
  - It is now as large as Preferences, with the same layout: a left rail with
    its own search box, guides grouped under *Getting started*, *Databases*,
    *Integrations* and *Organization*, and a header on every page.
  - It opens on a **home page** with a card per guide saying what it is for,
    instead of dropping you into the first guide.
  - **Search the text of every guide** from the rail (`Ctrl+F` while the
    viewer is open). Each result shows the passage with your words marked, and
    opens the page and the heading it sits under.
  - An **On this page** column follows your scrolling and jumps to a heading;
    on narrower windows those headings stay in the rail. **Previous / Next**
    buttons at the foot of every page carry on reading, into the next guide
    when one ends.
  - A guide that is also a Preferences section has an **Open settings** button,
    and there is a **View on GitHub** button for the guide's source.
- **Every Preferences section that has a guide now has a "Read the guide"
  button** in its header: Connections, Shortcuts, JSON Schemas, Shared origins,
  MCP, Pulse, AI and Managed policy. Connections and Shared origins open the
  guide on the part that explains that section. The two text links that MCP and
  Pulse had at the foot of their pages are replaced by it.

- **Settings → Connections shows how many connections are actually open.**
  - Each server now reads, for example, `2 open · 7 of 10 reserved`. Before, it
    showed only the reserved number, and that number is not what the server
    sees.
  - *Reserved* is how far HuginnDB's connections to that server are allowed to
    grow; *open* is what the server counts right now, and is usually much
    lower.
  - A new **?** button beside the counts opens the documentation section that
    explains both.

### Changed

- **More connections to the same server fit within its limit.**
  - Every connection used to reserve 5 of a server's 10. With two profiles
    pointing at the same server, a third was refused even though the server had
    only two or three connections open.
  - The first connection to a server still reserves 5. Each further one now
    reserves half of what is left, and never fewer than 2. That makes room for
    three connections instead of two.
  - When the limit is reached, HuginnDB first closes database views you
    haven't used recently on that server, and only refuses if that isn't
    enough.

### Fixed

- **Disconnecting felt slow and could report "could not read the schema".**
  - The window waited for the connection to finish closing before showing it
    as disconnected. Behind an SSH tunnel that wait lasts a few seconds.
  - During those seconds, any schema read still in progress failed and showed
    an error, even though you had asked to disconnect.
  - The tree, the connection's tabs and every other window now update
    together, immediately, and the connection finishes closing in the
    background.
- **A database you had expanded could quietly reopen after disconnecting.** A
  request that arrived just after the disconnect could open that database's
  connection again (with an SSH tunnel of its own), and nothing would ever
  close it. A database now only reopens while its connection is still open.
- **The connection limit shown in Settings ignored a connection's own limit.**
  A server with its own maximum set on the connection was shown against the
  global one. Each server now shows the limit that actually applies to it.
- **The MCP connector stopped working when HuginnDB was closed.** With the
  bridge on, the connector is meant to fall back to its own connections when
  the app isn't there to lend it one. It didn't: every tool call failed until
  the AI session was restarted. It now falls back as intended.
- **The first AI request after restarting HuginnDB failed.** A connector
  attached to the app kept using the old, already-closed link and only noticed
  once that request had failed. It now checks first and reconnects before
  sending.
- **A connector started while HuginnDB was closed never used the app's
  connections.** It checked for the app only once, at start-up. AI sessions
  often stay open for days, so most connectors were opening connections of
  their own for good. A connector now keeps looking for the app (at most every
  30 seconds) and switches to the app's connections when it finds it.
- **Pulse kept the MCP connector's connections open forever.** For a
  connection with Pulse turned on, its once-a-minute sample counted as
  activity, so a connection opened for the MCP connector was never closed for
  being idle. Samples no longer count.

- **Connections through an SSH tunnel dropped after a while and never came
  back on their own.**
  - The tunnel sent no keepalive of its own, so a firewall or router that
    clears idle connections could silently kill it.
  - Once it was dead, every query through it failed until you reconnected by
    hand.
  - Tunnels now send their own keepalive every 30 seconds, and a tunnel whose
    session has died reconnects by itself the next time it is used.
- **A lost connection needed a manual reconnect even after it came back.**
  - HuginnDB now retries twice before reporting a connection as lost, so a
    momentary blip (a VPN reconnecting, a laptop waking up) no longer raises an
    alert.
  - It also keeps checking a lost connection. When it answers again, the
    warning and its **Reconnect** button go away and you're told the
    connection was restored.
- **A query after a long pause could wait 30 seconds and then claim the server
  had too many connections.**
  - Each connection is checked before it is used. If that check got no answer
    (a connection the network had dropped in silence), it was never abandoned:
    the query waited the full 30 seconds and the timeout was reported as the
    server being full.
  - The check now gives up after 5 seconds, and the query simply gets a fresh
    connection. SQL Server connections, which were not checked at all, now
    get the same check.
- **Expanding a database on an SSH-tunnelled connection was slow.**
  - Every database you expanded opened a whole new SSH session to the bastion
    before its first query.
  - It now reuses the tunnel its connection already has, which makes opening a
    database more than twice as fast over a typical tunnel (about 0.8 s down to
    about 0.3 s).

- **Closing a window left its connections open.** A connection opened in a
  secondary window stayed open on the server after that window was closed,
  until HuginnDB itself exited. No remaining window listed it, so nothing
  could close it. A connection now closes when the last window using it does,
  and a floating tab or Pulse window counts as using the connection it shows.
- **Quitting HuginnDB didn't close its connections properly.** Open
  connections were simply dropped when the app exited. A server behind an SSH
  tunnel or a connection pooler could go on counting those sessions against
  its connection limit until its own timeouts fired. HuginnDB now closes them
  properly on the way out, waiting at most three seconds.
- **The same connection could be opened twice at once.** Two requests for one
  connection or database arriving together could each open a pool, briefly
  holding twice the connections against the server. This could happen with a
  window and the MCP connector, or with the tree expanding a database while a
  menu action on it ran. The second request now waits for the first and
  reuses its pool.

- **An expanded database showed a blank subtree while it loaded.** The schema
  tree now shows placeholder rows until a database's tables arrive, and a
  spinner on the database's own row while it is being opened or refreshed, so
  you can tell a slow server from an empty database even with the node
  collapsed.
- **A database that failed to open retried endlessly.** Expanding a database
  the server refused (for example, because it was out of connections) tried
  again straight away, forever, with a new error notification each time. It now
  stops at the first failure and shows the error with a **Retry** button.
  Collapsing and re-expanding the node also tries again.
- **A failed schema read had no way back except a context menu.** The error
  line in the tree now carries a **Retry** button.
- **Connecting fetched the schema twice.** With the connection's row already
  expanded, the database and table lists were read twice per connect.
  Requests already in flight are now shared, and the same goes for re-opening a
  table before its columns have arrived.
- **Every database you expanded re-read the server's whole database list.** A
  database now reuses the list its connection already has.
- **Expanding a MongoDB database was slow behind an SSH tunnel.** The tree
  waited until it had every collection's document count before showing any
  collection at all, and it asked for those counts one after another. Behind a
  tunnel, a database with ninety-odd collections took over two seconds to
  appear. The collections now appear straight away (about 25 ms over the same
  tunnel), and their counts and sizes fill in a moment later, read several at a
  time.
- **MongoDB collections never showed their size in the tree.** The read that
  was meant to fetch the sizes could not work against a database as a whole,
  and its failure was silently ignored. Sizes now come from the same per-collection
  read as the document count, at no extra cost. Sharded collections report
  the total across their shards.

## [1.31.1] — 2026-10-05

### Fixed

- **Window controls in a floating tab or Pulse window sat on the left.** The
  minimise, maximise and close buttons were drawn right next to the logo
  instead of at the right edge, because those windows' only title-bar content is
  the centred caption, which takes no room in the row. The title bar now fills
  the row itself, so the buttons land on the right in every window.
- **The query panel never opened in a floating tab window.** Its button kept
  spinning forever: the window never connects (it reuses the main window's open
  pool), so nothing opened the schema cache for its connection and every column
  read it made was discarded as stale. The window now opens that cache before
  the tab mounts.

## [1.31.0] — 2026-10-01

### Added

- **Open an environment in a new window (#219).** Right-click an environment in
  the rail and choose *Open environment in new window* to work in it beside your
  current one instead of switching away from a layout you have just arranged.
  The new window shows that environment's connections and database filters and
  reconnects the connections it had open, reusing a pool the main window already
  has. It stays ephemeral like any other secondary window: tabs and layout are
  not carried over, nothing is written, and the main window's environment and
  what it reopens at launch are untouched.

### Fixed

- **Deleting a row that other tables still reference now says so, in the dialog
  that asked for it (#218).** The refusal used to land in the strip above the
  grid, hidden behind the confirmation's scrim, so the click looked like it did
  nothing. The dialog now stays open with the reason and — when the cause is a
  foreign key — names the tables that still point at the row, and the button is
  usable again. With "confirm destructive actions" off, the failure is a toast
  instead of that strip, which stays for fetch errors only.
- **A MongoDB script with one call per line now runs every call (#220).** The
  `;` is optional in `mongosh`, but the query tab only split on it, so three
  `countDocuments` on three lines were one statement: the tab ran the first,
  the parser dropped the other two without a word, and there was a single
  result instead of three. A line break now ends a statement when nothing is
  left open — a `.sort(…)` on the next line or a multi-line `{ … }` still
  belongs to the statement above — so each call gets its own result tab and its
  own ▶ Run lens. The backend also stopped dropping trailing text: a single
  statement followed by another is now refused with an error (MCP `run_query`,
  the AI panel), instead of running the first and reporting success.

## [1.30.0] — 2026-09-28

### Added

- **HuginnDB now keeps itself up to date, even if nobody opens it.** Built for
  people who only use the MCP connector through their AI tool and never open
  the app, who until now never received an update. On Windows a scheduled task
  checks at sign-in and another once a day, and installs new versions quietly,
  through the same signed feed the in-app updater uses — and since the Claude
  Desktop extension hands its sessions to the installed connector, the
  connector updates with it. It never installs while HuginnDB is open, and the
  daily check also waits while an AI tool has the connector running; the
  sign-in check installs regardless, so a machine whose AI tool never closes
  still updates. It is on by default, needs no managed policy, and can be
  turned off in Settings → About → Background updates, which also shows which
  mechanism is in force: where a domain administrator forbids scheduled tasks
  it falls back to a startup entry, and where that is forbidden too it says so
  instead of pretending. If an update has still been waiting after a day, the
  MCP connector tells the AI tool, which passes it on — the connector reads
  that from what the app recorded and never contacts the update feed itself.
  Uninstalling HuginnDB removes the tasks.
- **Recent connections on the Windows taskbar.** Right-clicking HuginnDB's
  taskbar button (or its Start menu entry) now lists the connections you used
  last, and picking one opens it: with the app running it asks, as any
  command-line launch does, whether to open it in the current window or a new
  one; with the app closed it starts and connects. A **New window** task opens
  another window. Recent means the connections opened since launch first, then
  the rest by when their tabs were last touched; command-line ad-hoc
  connections, which are never saved, and connections opened by an AI through
  the MCP connector are left out. Windows keeps the list under your user
  profile, so only the connection's name and its engine are written to it —
  never a host, a database or a password — and Settings → General → Recent
  connections on the taskbar turns the category off (New window stays).

### Changed

- **One title bar instead of two.** On Windows and Linux the native title bar
  is gone, and HuginnDB's own bar — the menus, the connection breadcrumb, the
  notification bell and the panel toggles — now carries the minimise, maximise
  and close buttons too, the way Claude Desktop and VS Code do. That gives back
  the 32px row the native caption took on every window, including floating tabs
  and Pulse, whose bar shows the window's title. The window still drags from
  any empty stretch of the bar, a double-click maximises it, and Windows' snap
  (Win+Z, Win+arrows, dragging to a screen edge) works as before; the one thing
  missing is the layout picker that Windows 11 shows when the pointer rests on
  maximise, which Windows only offers on a button it drew itself. The canary,
  policy and window-colour ribbons now sit under the bar rather than above it,
  so the close button stays in the window's corner. macOS keeps its native
  frame.

### Fixed

- **The "open incoming connection" prompt named a connection by its id.** A
  launch with `--connect-profile-id` — which every taskbar entry uses — asked
  whether to open "62a5d650-23a7-…" rather than the connection's name. It now
  shows the name, and falls back to the id only when no connection has it.

- **The Claude Desktop extension now updates with the app.** The `.mcpb`
  carried its own copy of the connector, and Claude Desktop kept running that
  copy whatever version of HuginnDB was installed next to it — so new tools
  never reached the assistant, and an extension older than 1.29 did not apply
  a managed policy the app itself enforced. On Windows the extension now hands
  every session to the connector installed with the app, so it is installed
  once and each HuginnDB update is also a connector update. Without an
  installed app it serves the session itself, as before; `HUGINNDB_MCP_PATH`
  points it elsewhere, or, set but empty, turns the hand-over off. Installing
  this version of the extension is the last time it has to be done by hand.

- **The window-state file no longer grows with every window you open.**
  HuginnDB remembered the position and size of every window it had ever
  shown, but floating tabs, Pulse windows and **New window** get a fresh
  internal name each time, so none of those entries could ever be used again
  and none was ever removed. Only the main window is remembered now, and the
  leftovers are cleared from `.window-state.json` on the first launch of this
  version. The main window keeps its saved position and size; secondary
  windows open where they always did.

## [1.29.0] — 2026-09-28

### Added

- **Ctrl+F finds in whatever you are looking at.** With a table tab active it
  puts the cursor in that table's filter box, selecting what is there so you
  can type straight over it; with no table tab active it goes to the schema
  tree's filter, opening the panel if it is collapsed; with Preferences open
  it goes to the settings search. Inside a query or JSON editor it does
  nothing of its own, so the editor's find keeps working exactly as before,
  and inside any other dialog it leaves the key alone rather than aiming at a
  box the dialog is covering. Ctrl+Shift+F still goes to the tree from
  anywhere, and both can be rebound in Settings → Shortcuts.

- **Managed policy: an administrator decides, once, what the AI may reach on
  every installation.** Built for organizations deploying HuginnDB to many
  workstations, where configuring each one by hand was the objection. A
  policy — in `HKLM\SOFTWARE\Policies\HuginnDB` or `managed-policy.json` in
  the system policy folder, either inline or pointing to a file on a share —
  gives each OS account one role, and each role rules per server: which
  databases and relations are visible, and whether the AI may select, insert,
  update, delete or change schema, each granted separately, plus `monitor` for
  Pulse, sessions and users. This version applies it **to the AI**, where it is
  enforced rather than advisory: the model never holds a credential, and every
  request from the MCP connector (with or without the app running) and from
  the AI panel's agent and assisted tasks passes through the one function the
  policy is checked in. Discovery is filtered, so the AI does not learn the
  names of what it cannot reach; free-form queries are withheld wherever a rule
  limits which relations may be seen, since no query text can be checked
  against that; and the AI never gets more than its user's own `human`
  permissions. It only ever narrows the per-connection MCP and AI settings.
  An unreadable or invalid policy blocks every AI request instead of falling
  back to none, a typo in the file is an error rather than a missing
  restriction, and the account is read from the operating system, never from
  `USERNAME`. **Settings → Policy** shows where the policy came from, the
  account and role, and what each connection allows — opening on the
  connections a rule names, one line each until expanded, with a name filter
  for machines with dozens of them; the MCP audit log now
  records `user=` and `role=`. Applying the `human` permissions to people in
  the app is the next phase. See [`docs/POLICY.md`](docs/POLICY.md) and
  `CLAUDE.md` gotcha #94.

- **Managed policy now applies to people too, as a guardrail.** The `human`
  permissions a role carries were read and shown, and bounded the AI, but the
  app's own commands did not apply them. Now every command that touches a
  database checks them first — 60-odd, each naming what it does: listings are
  filtered so a hidden database or relation is never named (foreign keys
  pointing in from a hidden table included), reads, inserts, updates, deletes
  and DDL are refused per relation and per verb, `export` guards every way rows
  leave to a file, and `monitor` guards Pulse, sessions and the Security panel.
  Free-form SQL is refused under a rule that limits relations, and so is
  everything that is free SQL without looking like it: the query panel's
  hand-written `WHERE` expression (a subquery reads any table), a view's body,
  a MongoDB pipeline that joins other collections through `$lookup` /
  `$unionWith` / `$graphLookup`, a foreign-key picker reading its target, a
  rename that moves a collection to another database. A broken or unreadable
  policy leaves a person able to open the app and its settings but not to read
  or write any connection. It is a guardrail and says so: a person holding the
  database password can use another client, which per-person database users
  (the next phase) are what close. A test fails when a new command is
  registered without stating what the policy asks of it, and another when a
  command that touches a database never calls the guard. See `CLAUDE.md`
  gotcha #95.
- **What the managed policy does not allow is locked in the interface, with
  the reason.** The commands already refused it; now the controls say so
  before they are used. A menu item a person's role does not allow stays
  where it was, disabled, with a lock and one line under its label saying
  what the policy does not allow — drop and rename, new table and view,
  import, export, Security, create and drop database, connect. A tab whose
  whole purpose is refused shows a locked empty state instead of failing on
  every request: the query editor without free SQL (including query tabs
  restored from the last session), Security and Pulse without `monitor`, any
  tab while the policy is loading or broken. In the grid, editing, inserting,
  duplicating, deleting and bulk-updating follow their own verb, and one line
  above the rows names what is missing; export follows `export`; on SQL the
  query panel's hand-written expression is locked under a rule that limits
  relations, and one already applied stays visible, and removable, without
  being sent. Structure, view, aggregation and index editors lock Apply,
  Save and Create; a view's live preview says why instead of running its
  body. A bar across the window says when the policy is loading or could not
  be applied, with a link to Settings → Policy, whose text now describes
  people as well as the AI. Nothing changes on a machine without a policy:
  there, one call learns that and no relation is ever asked about. See
  `CLAUDE.md` gotcha #96.

- **Each person can sign in with their own database user.** The managed
  policy is a guardrail for people as long as a shared database password can
  open any other client; a database user per person, with matching grants, is
  what lets the database enforce it. A rule's new `dbUser` fixes the user a
  person signs in to that server as — a template whose one token, `{user}`, is
  their OS account without the domain (`"{user}"`, `"erp_{user}"`) — and the
  connection dialog shows it locked. Without it, a person can choose their own
  user on a connection from a shared origin ("Your credentials"), kept on this
  machine only: never published, exported or synced. While a personal user is
  in force the origin's shared password is no longer stored on the machine,
  which is what keeps it from opening another client there. A connect that
  finds no password for the user it signs in as now asks for it, and can
  remember it, instead of reporting an empty keychain — for any connection,
  not only these. On MongoDB the published user and password are taken out of
  the connection string. Settings → Policy shows the pinned user. Versions
  before this one read a policy with `dbUser` as invalid and block, so update
  every installation first. See `CLAUDE.md` gotcha #97.

- **HuginnDB writes the database permissions a policy role needs.** A
  database user per person only enforces the policy if its grants match the
  role, and writing those by hand for every role and server is where it would
  drift. Settings → Policy → **Generate grants** picks a role and a server the
  administrator is connected to, reads its catalog, and writes the script:
  a `huginn_<role>` database role with its `GRANT`s on PostgreSQL, MySQL and
  SQL Server, a `createRole` with per-collection actions on MongoDB. A rule
  over every relation of a database grants at the database or schema level
  (tables created later are covered); one that names relations or has a
  `deny` is expanded into the tables that exist now, since a `GRANT` takes no
  wildcards, and the script says to regenerate it. Rules add up on the same
  object; `ddl` and `monitor` map to each engine's own permissions; the people
  the policy gives the role are listed commented out, as they sign in. The
  notes say what the engine cannot hide — PostgreSQL's `pg_catalog` names, SQL
  Server's database list (the `VIEW ANY DATABASE` revoke is offered,
  commented) — and that `export` has no database equivalent. HuginnDB never
  runs it: the dialog offers Copy and Save. See `CLAUDE.md` gotcha #98.

- **The managed policy can be edited in HuginnDB instead of by hand.** It was
  a JSON file an administrator wrote on a share, and one typo locked every
  computer out, since the policy fails closed. Settings → Policy → **Edit
  policy** opens it as a form — roles and their rules (server, databases,
  tables, what the person and their AI may do, their database user), accounts,
  the default role — with the JSON one pane away; both edit one draft, and a
  field this version does not know rides along untouched. Every change is
  checked by the parser that applies the policy, and a draft that is not valid
  cannot be saved. **View as** shows what any account and its AI would get on
  each saved connection under the draft. A rule's server is picked from the
  saved connections, and its databases and tables from that server's catalog
  (connectable from the rule itself); a pattern such as `v_factura_*` can be
  added too, and the field says which real names it matches before it is.
  Who may save is decided by the share: the editor saves only where Windows
  lets the account write the policy's folder, and is read-only elsewhere with
  Windows' reason. A save keeps a `.bak`, never overwrites a change someone
  else made meanwhile (your text goes to the clipboard), and applies here at
  once. **Create policy** starts an unmanaged organization from a template
  that keeps its author in and hands over the `reg add` command and the Group
  Policy value; an inline policy moves to a file the same way. See `CLAUDE.md`
  gotcha #100.

### Changed

- **Preferences is regrouped, searchable, and shows what you changed.** The
  dialog had grown to fourteen sections in one flat rail, each section laid
  out its own way. The rail is now grouped — Workspace, Data & sharing,
  Integrations, Organization, with About pinned at the foot — one line per
  entry, and it says what you would otherwise open a section to learn: how
  many connections the MCP connector exposes and Pulse samples, and whether
  the AI panel is on. A search box at the top finds any of the ~65 settings
  by name, description or keyword (in either language, accents ignored);
  Enter opens the first match on its row, and Escape clears the search
  before it closes the dialog. Every section now opens with the same header,
  and the long lists are split into titled cards (Editor into *Theme & type*,
  *Display*, *Formatting*; Connections into *Pool limits*, *Liveness &
  timeouts*, *MCP connector*; and so on). A setting you have moved off its
  default carries a dot and a one-click reset, the section header counts
  them with a *Reset section* that asks first, and the rail marks the
  sections that hold any. The AI endpoint settings and the interface
  language are deliberately left out of that: they describe your setup, not
  a tweak, and "reset" would point the panel at another server or switch you
  to English. The rails of the shared-origin and policy editors adopt the
  same entry style, since all three share one component. Every section now
  follows the same anatomy, the composite ones included: Appearance's theme
  list and editor are one card instead of two boxes side by side, JSON
  Schemas' library, bindings and test are titled cards with their actions in
  the header, Origins lists its registrations and inline forms the same way,
  and Policy and About drop their hand-drawn boxes. The per-connection lists
  of MCP, Pulse and the AI panel — which had each drawn their own copy of the
  same scope switch, filter and bulk toggle — now share one card with that
  toolbar inside it. Hard-coded greens and ambers in those sections now use
  the theme's success and warning colours, so custom themes recolour them.

- **Every button now has a visible edge.** Toolbar icon buttons and `ghost`
  buttons used to be invisible until the pointer found them, so an action
  such as Refresh or Export read as a loose glyph beside the grid. Every
  button now carries a 1px hairline taken from the text colour rather than
  from the theme's border token, so it stays legible on imported VS Code
  themes whose border colour is close to invisible. Filled buttons (Run,
  Save, Delete) get an edge in a darker shade of their own fill, plus a faint
  inner highlight, instead of the old 2px outline and hover lift. Corners
  move onto the `--radius` scale: 10px at full size, 8px on dense and icon
  buttons. Dense chrome stays flat on purpose: row actions that appear on
  hover, the cross inside a filter chip or search field, menu-bar triggers
  and inline controls. Outlining those would put a box inside a box.
  `Button` and `IconButton` take a typed `flat` prop for this, and
  `revealOnHover` implies it.

- **Sixty hand-built buttons now use the shared `Button` and `IconButton`.**
  They pick up the same heights, hover, focus ring and edge as the rest of
  the app, and icon buttons show the app's own tooltip instead of the
  operating system's. Most of the change is invisible; the parts you may
  notice: the status bar, activity bar, notification bell and layout toggles
  are all proper controls with themed tooltips; Pulse's 24 h / 7 d / 30 d
  range and the import conflict chooser are segmented controls, so each is
  one Tab stop moved with the arrow keys; the schema tree's expand chevron,
  the index and foreign-key delete buttons in the structure editor (which
  had no accessible name) and the JSON Schema library's duplicate, delete
  and full-screen buttons are labelled icon buttons, with delete muted until
  hovered. The collapsible headers of the AI, MCP and Pulse connection
  pickers share one new `FoldRow` primitive. What stays hand-built is
  documented next to its count in `uiAdoption.test.ts`: whole clickable rows,
  chips below the 24px floor, and toast controls, where a themed tooltip
  would render behind the notification.

### Fixed

- **The side cell editor's full-screen button now goes full screen.** It
  swapped its icon and did nothing else: the side split is wrapped in layout
  containment for performance, which traps a `position: fixed` element inside
  it, so the "full screen" editor covered exactly the panel it was already in.
  It now moves to the top of the window while maximised and comes back to the
  split with the same text when you leave (the button, F11 or Escape), and
  saving or discarding the cell leaves full screen too, so the next cell does
  not open maximised.

- **Inserting or duplicating a MongoDB document from the grid keeps each
  field's type.** A row added through the grid's insert draft, or duplicated
  from an existing one, was written with every field as a string: a `Long`
  such as `atnId: 5` became `"5"`, and booleans and timestamps went the same
  way. The grid did send the column's type with each value, but the backend
  read that hint under a different spelling and dropped it, so the insert fell
  back to text. The same lost hint affected bulk updates, and SQL Server
  binary columns written from an insert draft. Editing a cell that already
  existed was never affected.

- **The grid's search box and the foreign-key picker speak the interface
  language.** With the app in Spanish, the search box's clear and
  recent-searches buttons still announced themselves in English, and the
  foreign-key picker on insert drafts showed its placeholder, "Loading…",
  "No matches", the "showing first N rows" hint and its lookup-failed tooltip
  in English too, as did the "auto" marker on an auto-generated key column in
  the insert draft. All of them now come from the locale files, in English and
  Spanish.

- **A segmented control with nothing selected can be reached with Tab again.**
  Segmented controls keep only their selected segment in the Tab order, so when
  the current value matched none of the segments — a custom duration typed
  next to the notification presets, for instance — every segment was skipped
  and the whole strip was out of reach from the keyboard. The first segment now
  takes the Tab stop when nothing is selected, as a radio group should, and the
  arrow keys move from whichever segment has focus, carrying the focus with the
  selection instead of leaving it behind. The notification duration presets in
  Settings → Notifications now use this control rather than their own buttons,
  so they are reachable and arrow-navigable too; they take its neutral raised
  style in place of the brand-filled one.

- **"Edit at origin" in the connection manager no longer stacks the origin
  editor on top of it.** The link a publisher gets on a connection their
  origin shares opened the full-screen origin editor while the connection
  manager, also full-screen, stayed open underneath — the pairing that traps
  keyboard focus in whichever of the two opened last. The manager now steps
  aside while the editor is open and comes back on the same connection when
  it closes, saved or not; the same holds when the republish prompt hands a
  conflict to the editor. The unsaved edits in the manager's form are not kept
  across the trip: it reopens on the connection as it is saved. The empty
  workspace's "New connection" button now opens the File menu's manager
  instead of a private copy of it, which is what lets the editor reach it, and
  connecting from there now selects the new connection as the menu already
  did. See `CLAUDE.md` gotcha #101.

- **Errors from the MCP connector no longer repeat their prefix when the app
  is open.** With the desktop app running, the connector hands its work to the
  app, and a refusal came back doubled — `invalid input: invalid input:
  "payroll" … is not available to the AI` — because the app's error, already
  worded, was wrapped as a new one on the way out. It now reads exactly as it
  does when the connector works on its own. The connector's own bridge
  failures (the app not answering in time, or closing before it answered) also
  lose an `invalid input:` they never deserved.

- **Leaving the shared-origin editor returns to Settings.** Opening the editor
  from Settings → Origins closed Settings, as it should: two full-screen
  dialogs must not be stacked. But leaving the editor, saved or not, then
  dropped you on the main window. Settings now steps aside while the editor
  is open and comes back on Origins when it closes. Opened from a
  connection's "edit at origin" banner instead, the editor still leaves
  Settings closed. The new policy editor works the same way. See `CLAUDE.md`
  gotcha #101.

- **A managed policy no longer breaks for five minutes because its share
  blinked.** A policy in force that could momentarily not be read — the share
  did not answer, or another machine was replacing the file at that instant —
  was declared broken on the spot, and a broken policy locks every connection
  until the next read, five minutes later. A policy that was in force is now
  read again a few times before being declared broken; one that reads but is
  not valid is still broken at once, since reading it again only reads the
  same mistake. The groundwork for the in-app policy editor lands alongside:
  it opens, checks, previews for any user, and saves the policy with the
  shared-origin editor's safeguards (a real write test on the share, a
  conflict check against the file as opened, a `.bak`) and a replace that
  never leaves the path without a file. See `CLAUDE.md` gotcha #99.

- **An empty MongoDB collection still had no way to insert its first
  document.** 1.25.0 fixed half of this: `infer_columns` seeds `_id` as the
  primary key when the sample comes back empty. But the grid's write gate
  (`TableDataTab`'s `hasPk`) also requires every PK column to be present in
  the *browse result*, and the browse builds its columns from the documents it
  returns — zero documents, zero columns — so `_id` was known to be the key
  and still missing from the page, and Insert stayed hidden. The browse
  (`fetch_collection_data`) now reports an `_id` column when its page is
  empty, the MongoDB counterpart of the catalog fallback the SQL drivers got
  in #27. It also covers a filter that matches no document, which hid Insert
  the same way. Ad-hoc queries are untouched: an empty `find` in the editor
  still reports no columns.

### Security

- **Documented: the managed policy assumes a single Windows domain.** An
  account is matched without its domain, so `ITBACKING\alopez` and
  `CLIENT\alopez` are the same user to the policy and get the same role.
  `docs/POLICY.md` now says so, and says not to deploy the policy in a forest
  of trusted domains with overlapping account names until domains are
  compared too.

- **Three statements that write were classified as reads, and ran under a
  read-only policy.** The tier a statement needs — what a `read-only` MCP
  connection and the AI panel's no-write rule check — is decided from its text,
  and three shapes read as a `SELECT` by their first word:
  - a `WITH` carrying DML: Postgres runs `WITH d AS (DELETE FROM t RETURNING *)
    SELECT * FROM d`, and Postgres and MySQL 8 accept a `WITH` in front of a
    top-level `INSERT` / `UPDATE` / `DELETE`;
  - `EXPLAIN ANALYZE`, which on Postgres and MySQL *executes* the statement it
    measures — `EXPLAIN ANALYZE DELETE …` deletes;
  - a MongoDB `aggregate` ending in `$out` (replaces a collection) or `$merge`
    (writes into one), classified by the method name alone.

  All three now get the tier of what they do: a `WITH` with a DML keyword in its
  code is a data write (literals, quoted names and comments are ignored, and so
  are `FOR UPDATE` and T-SQL's `MERGE JOIN`), `EXPLAIN ANALYZE` takes the tier
  of the statement it runs while a plain `EXPLAIN` stays a read, `$out` is DDL
  and `$merge` a data write. On the way, `WITH … INSERT INTO …` stops being
  reported as DDL because of its `INTO`, which had kept it away from a `data`
  connection allowed to insert.

  **And the database now enforces it too.** A statement an AI sends that is
  classified as a read runs inside a read-only transaction on PostgreSQL and
  MySQL, and with `PRAGMA query_only` on SQLite, so a write the classifier
  misses fails on the server instead of executing. Limits, stated plainly: SQL
  Server has no read-only transaction and MongoDB no such mode, so those two
  rely on the classifier alone; and on MySQL a DDL statement commits implicitly
  before running, so there the barrier stops DML, not DDL. See `CLAUDE.md`
  gotcha #93.

## [1.28.0] — 2026-09-23

### Added

- **Explain, from the query panel.** The *Result* line has an **Explain**
  button: the plan the panel's draft would use, read without running it, in a
  box of bounded height under the statement. It is the engine's own answer —
  `EXPLAIN (FORMAT JSON)` on PostgreSQL, `EXPLAIN FORMAT=JSON` on MySQL,
  `EXPLAIN QUERY PLAN` on SQLite, and MongoDB's `explain` at `queryPlanner`
  verbosity — shown as JSON the way Pulse already shows it. The SQL plan is read
  from the very page statement the browse runs, with its real bound values, so
  it is the plan of what executes; collation, hint and projection included. A
  plan read for one draft is dropped as soon as the draft changes. SQL Server is
  refused with the reason: its plan needs `SHOWPLAN` in a batch of its own,
  which the panel cannot issue yet.

- **Collation and an index hint, per browse.** The query panel's **Advanced**
  row — folded to one line until opened — sets two things the planner and the
  sort normally decide on their own:

  - **Collation.** On SQL it applies to every sort key, spelled the way each
    engine names one (`COLLATE "es-ES-x-icu"` on PostgreSQL,
    `utf8mb4_spanish_ci` on MySQL, `Latin1_General_CI_AS` on SQL Server, and a
    picker with SQLite's three). On MongoDB it is a collation document
    (`{ locale: 'es', strength: 1 }`) that the server applies to the filter
    *and* the sort, so the count carries it too — with `strength: 1`, "a" and
    "A" are the same value. A collation cannot be a bind parameter, so the
    names are checked before they are spliced in.
  - **Index (hint).** A picker with the table's own indexes. The browse forces
    it (`FORCE INDEX` on MySQL, `INDEXED BY` on SQLite, `WITH (INDEX(…))` on
    SQL Server, `hint()` on MongoDB), and each of those fails rather than
    ignoring an index that no longer exists — the honest behaviour for
    something set on purpose. PostgreSQL has no index hints, so the picker
    is disabled there and says so.

  Both show in the *Result* line and are exported, saved with the tab and
  shown as an **Advanced** chip while set. The MongoDB query tab's grammar
  learned `.collation(…)` and `.hint(…)` too, so *Open in editor* still hands
  over something it runs as written, and Pulse's `explain` passes both on.

- **Write the filter by hand, and see the query it runs.** The query panel's
  *Filter* row takes an **expression** next to its conditions: a condition as
  you would write it after `WHERE` on SQL, or a filter document on MongoDB in
  the query tab's own syntax (unquoted keys, `ObjectId(…)`, `ISODate(…)`,
  regex literals). It is ANDed with the conditions, the chips and the search
  rather than replacing them, so nothing has to be converted between the two
  forms and the chips still map one-to-one to the panel's rows. It shows as an
  **Expression** chip while it is active, and it is counted, exported and saved
  with the tab like everything else in the panel.

  A SQL expression has to stay one condition. The panel refuses a `;` outside a
  string or comment, unbalanced parentheses, and an unterminated string or
  `/* comment` — the three ways a fragment spliced into the browse's `SELECT`
  could end it early, escape the `AND` or swallow the `LIMIT`. This is not a
  security boundary: the query tab next door runs anything at all.

  A new **Result** row shows the statement the panel's draft would run, built by
  the same backend code the browse uses, so it cannot say something different
  from what executes. It sits on one line; its expand toggle opens the formatted
  statement in a bounded box, so a long MongoDB filter does not push the rows
  out of view. SQL values are shown inline, for reading only. MongoDB is
  shown as a `db.<collection>.find(…)` in the query tab's grammar. **Copy** and
  **Open in editor** take it elsewhere; the latter opens a query tab that runs
  it as written — the way out for anything the panel cannot express. An
  expression that does not parse shows its error there, and Apply stays
  disabled until it does.

  *Bulk update* cannot carry an expression (its match side is conditions only),
  so while one is active it now says so above its conditions.

- **Go to row.** The table footer takes a row number and moves the page to
  start there — row 250 shows 250–349, the range the footer already counts in.
  It is the grid's answer to Compass's *Skip*: separate Skip and Limit fields
  would have fought the pager over the same offset.

- **Projection: choose which fields a table or collection returns.** The
  query panel has a second row. On SQL it is **Columns** (*All* / *Choose*);
  on MongoDB it is **Projection** (*All* / *Include* / *Exclude*). The browse
  then asks the server only for those fields — a `SELECT` list, or `find()`'s
  projection document — so a table with a wide JSON or text column, or a
  collection whose documents carry a large sub-document, stops shipping it on
  every page.

  The key always comes back. Every edit addresses a row by its primary key and
  a document by its `_id`, so the panel shows them as locked instead of
  offering a choice that would leave the rows read-only, and `_id` cannot be
  excluded. Paths MongoDB refuses together (`meta` with `meta.plant`) are not
  offered once one of them is picked. While a projection is on, a **Fields**
  chip on the chip row names it, opens the panel, and its ✕ returns every
  field again — a column that is missing for no visible reason reads as a
  bug. *Duplicate row* is unavailable meanwhile, because the copy would drop
  the hidden columns' values without saying so. The projection is saved with
  the tab, like its filters and sort.

- **"Export query results" writes what the grid shows.** It already honoured
  the filters. It now also honours the sort (the file is in the grid's order)
  and the projection. A SQL export's `INSERT`s name only the projected
  columns, so the others take their defaults on the way back in; a MongoDB
  export writes the projected documents.

- **Sorting in the list view, and a sort you can see in both modes.** The
  browse sort was always server-side and it kept applying in the list view, but
  the only way to set it was clicking a column header, and the list view has no
  headers. A collection sorted in table mode stayed sorted in list mode with
  nothing on screen saying so, and a collection opened in list mode could not
  be sorted at all. Users coming from MongoDB Compass reached for its Sort field
  and found nothing.

  The sort now has three entry points that work in both view modes, on every
  driver:

  - A **Sort** button (⇅) in the grid toolbar, next to the advanced filter. It
    lists the table's columns (on MongoDB, the fields on the page, nested
    paths included) and builds a multi-level sort one field at a time. It
    carries the same count badge as the filter button.
  - **Sort chips** beside the filter chips. Click one to reverse its direction,
    ✕ to drop it. When there is more than one level they show their rank. In
    table mode they also keep a sort visible after its column has scrolled out
    of view.
  - A **context menu on every field** of the list view: *Sort ascending /
    descending by …* (this replaces the sort, like a plain header click; the
    toolbar menu is the one that adds levels), *Remove … from the sort*,
    *Filter by this value* and *Filter excluding this value*, which the list
    view never had, and *Copy*.

  On MongoDB a nested field sorts and filters by its dotted path. Inside an
  array the index is dropped, as the advanced filter already did:
  `items.0.sku` sorts on `items.sku`, because `sort()` does not read a
  positional index, and filtering on one element of `tags` asks for documents
  whose `tags` contains it. On SQL only top-level fields get these entries,
  because `ORDER BY` and `WHERE` name a column. This is the first step of the
  query bar users asked for (projection, a raw filter and the rest come
  in later releases). The backend is unchanged: it already accepted everything
  these controls send.

### Changed

- **The advanced filter is now a panel under the toolbar, not a dialog.** The
  filter button (same place, same count badge) opens and closes a **Query**
  section between the toolbar and the rows. It holds the same AND list of
  conditions the dialog did, with the same field picker, operators and MongoDB
  value types. The rows it shapes now stay visible under it instead of behind a
  modal. Clicking a filter chip opens it on that chip's condition, as before.

  Nothing reaches the server until **Apply** (or Ctrl/⌘+Enter inside the
  panel). If the filters change from outside while it is open (a chip's ✕, a
  right-click *Filter by this value*), a panel that says the same as what is
  applied follows them. A panel whose draft differs keeps your edits and says
  *Unapplied changes* — a comparison, so undoing an edit clears it; **Reset**
  goes back to what is in force. Closing the panel discards unapplied edits, like
  cancelling the dialog did.

  This is the surface the rest of the query bar grows into: projection, a raw
  filter and a preview of the query that will run. The dialog is removed
  rather than kept alongside it, so there is only ever one place that edits the
  active filters.

- **The filter and sort chips have a row of their own under the toolbar.**
  They used to sit inline after the search box, where they competed with the
  search and every action for the same line. From a medium pane width down
  they folded into a single "N filters" chip, which hid the conditions exactly
  when there were enough of them to matter. The new row is labelled
  *Filters · Sort*, only appears when there is something to show, and wraps
  instead of folding. The summary chips are gone.

### Fixed

- **A MongoDB "Export query results" ignored the free-text search.** It
  applied the filter chips but dropped the search box, so an export made while
  searching wrote documents the grid was not showing. It now uses the same
  filter the browse does.

- **The foreign-key picker kept offering a key that no longer existed.**
  Rename a primary key (`5` → `50`) and then edit a cell that references it:
  the picker still listed `5`, and `50` was nowhere to be found. F5 didn't
  help, and neither did reopening the table. The picker cached the
  referenced values the first time it opened and never asked again for the
  rest of the session. Now it still shows the cached list straight away, but
  it re-reads the referenced table every time it opens and swaps in the fresh
  list, so a change made from the grid, the SQL editor or another client
  shows up on the next open. If that re-read fails, you keep the list you
  had, rather than getting a free-text box. The cached options are also
  dropped on disconnect now, including those of the databases a multi-DB
  session opened. That cleanup already existed; nothing ever called it.

## [1.27.0] — 2026-09-23

### Added

- **The table's `CREATE` statement, ready to copy, in the structure editor.**
  Users coming from HeidiSQL reached for its *CREATE code* tab and found nothing
  equivalent: the only SQL on screen was the DDL preview, which is the *diff*
  for pending edits, not what the table is. The structure editor now has a
  fourth section, **CREATE**, showing the definition exactly as the server
  stores it — MySQL/MariaDB's `SHOW CREATE TABLE` (engine, charset, collation,
  comments, partitions included) and SQLite's `sqlite_master` text followed by
  the table's own indexes and triggers — with a **Copy** button. It refreshes on
  reload and after a successful Apply, never from unsaved edits.

  It is deliberately absent on PostgreSQL and SQL Server. Neither stores the
  statement, so it would have to be rebuilt from the catalog, and the builder
  the editor uses drops what `TableStructure` does not carry (comments,
  `CHECK`s, table options). A "ready to paste" statement that is quietly
  incomplete is worse than no statement at all.

- **An operation timeout you can set per connection.** Expanding the tree on a
  SQL Server holding several hundred databases failed with *"list_databases took
  longer than 20s — the connection may be unresponsive"* — on a connection that
  had opened in under a second. The server was not unresponsive; it was large.
  `sys.databases` filtered by `HAS_DBACCESS` evaluates a permission check per
  database, and there was no way to tell the app to wait.

  Twenty seconds was a hard constant, which is to say an assertion about a
  server HuginnDB has never seen. It is now the *default*: **Settings →
  Connections → Operation timeout** sets it globally, and **Operation timeout
  for this server** in the connection dialog overrides it for one connection,
  next to the pool ceiling that answers the same shape of question. Blank means
  the global preference.

  It bounds only the reads the app issues on its own behalf — listing databases
  and tables, describing a relation, the liveness ping. A query **you** run has
  never been bounded and still is not. Like the pool ceiling it travels with the
  profile, so it reaches exports, shared origins and the MCP connector without
  any extra setup.

  The error also names the fix now, instead of describing a broken connection
  the user then goes looking for.

- **A value type per filter condition, on MongoDB.** A better default is still
  a default: a schemaless collection can legitimately hold a `long` in some
  documents and a string in others, and no sample can settle that. Each
  condition now carries its own **Auto / String / Number / Long / Boolean /
  Date / ObjectId**, defaulting to Auto — which is exactly what the filter did
  before.

  Two of them do something no amount of inference could. **Long** keeps the
  digits as text, so a value past 2^53 is not silently rounded on its way
  through JavaScript. **ObjectId** is the only way to filter an ObjectId stored
  in a field other than `_id`, which was previously unfilterable.

- **Filter chips show what type the value actually is** on MongoDB: a string is
  quoted, and the typed forms read `ObjectId("…")`, `ISODate("…")`,
  `NumberLong("…")` — the shell's own spellings, and the ones the console log
  already uses. `value <> 5682380` and `value <> "5682380"` are different
  questions and used to print identically, which is what let the original bug
  hide in plain sight. SQL chips are unchanged: there the value is a bound
  parameter coerced against its column, so the distinction does not exist.

- **Dropping a table names the tables that reference it, before you confirm.**
  The drop dialog used to be silent about foreign keys, so the first sign of
  one was the server refusing the drop. That refusal is not much help: on MySQL
  5.7 and MariaDB (1217/1451, *"a foreign key constraint fails"*) it names no
  table at all, and MySQL 8.0's 3730 names only one of possibly several. The
  dialog now looks up every foreign key on *another* table pointing at this one
  and lists it as `table (columns) → constraint`, with the table's schema when
  it lives in a different one. Self-references are left out, since they do not
  block the drop. Works on MySQL/MariaDB, PostgreSQL, SQLite and SQL Server.

  The lookup is advisory and never blocks the button. If it fails, the dialog
  simply shows nothing, and the server keeps the last word: FK checks may be
  switched off, and PostgreSQL has `CASCADE`.

### Fixed

- **A MongoDB filter no longer asks the wrong question about a field whose
  stored type has changed.** `value <> 5682380` left every row it was meant to
  exclude on screen, and the console showed why: the value went out as an
  `Int32` while the grid header above it labelled that column `STRING`.

  A MongoDB column is typed twice, from two different populations. The header
  types it from the page on screen; the advanced filter was typing it from the
  catalog's 100-document sample of the whole collection. On a field that used
  to hold numbers and now holds strings those two disagree — and BSON equality
  is exact by type, so `$ne` against the wrong one excludes nothing and reports
  nothing. Every step was correct in isolation; the screen simply could not
  explain the result.

  The filter now takes the page's answer, the same one the header prints,
  falling back to the catalog where the page cannot decide (a field that
  disagreed with itself across rows, or that was null throughout). Nothing
  changes on PostgreSQL, MySQL, SQLite or SQL Server, whose catalog types are
  authoritative rather than sampled.

## [1.26.1] — 2026-09-18

### Added

- **"Edit connection…" on a connection's right-click menu.** Changing a saved
  connection's host, port or username meant File → Manage connections and then
  finding the row again in a list that is routinely fifty long — from a tree
  node that already knew exactly which connection you meant. The manager now
  opens focused on it. Offered while disconnected too, which is where it is
  needed most: a connection that will not open is the one you want to correct.
  
### Fixed

- **An imported VS Code theme now actually reaches the SQL editors.** Two
  faults stacked on top of each other, and between them an imported theme's
  editor half was unreachable.

  Picking one in Settings → Editor crashed the panel outright: the preview
  read the colours out of the built-in catalogue, which an imported id is not
  a key of, so it dereferenced `undefined` and took the whole Settings dialog
  down with it.

  And even chosen successfully, it never applied. An imported theme's
  definitions are read from `installed_themes.json` one async call *after*
  first paint, so an editor mounting in that window resolved the id down to
  the default — correctly, since Monaco throws on an id nothing has defined —
  and nothing brought it back, because the id was computed from a module-level
  registry no component was subscribed to. The result was every editor in the
  app stuck on HuginnDB Dark for the whole session while the chrome showed the
  imported palette. The id is now derived from the theme store, so the same
  update that registers the definitions repaints the editors.

- **Installing a theme now themes the editor too.** The app chrome took the
  imported palette and the editor was left where it was, with nothing in the
  UI saying they were separate knobs. Installing or updating a theme points
  the editor at that extension's own editor colours, a light/dark flip follows
  the family to its other side, and deleting a theme moves the editor off the
  id that just stopped existing. An editor deliberately parked on a curated
  theme — Monokai, GitHub Dark, a VS built-in — is never overwritten: that is
  a choice made independently of the chrome.

- **Leaving the port blank now means "this driver's default" instead of port
  zero.** A connection saved without a port was dialled verbatim — `host:0` —
  and came back as a connection refused naming a port you never typed. An
  empty port field now resolves to 5432 / 3306 / 27017 / 1433 at connect time,
  and the field shows that number in grey so it is clear what leaving it empty
  will do. The same applies to a `--port`-less CLI launch and to an imported
  profile that omits it.

  The port is **not** written into the profile: `profiles.json` keeps
  recording that you did not choose one, so the connection follows the
  driver's default rather than freezing today's value, and a connection shared
  through an origin does not push a number its publisher never entered.

- **SQL Server named instances are discovered through the SQL Browser — for
  real this time.** The lookup was being sent to the instance's own TCP port
  instead of to the Browser's UDP 1434, so it always timed out and the
  connection only succeeded if you had also typed the instance's static port,
  which is used as a fallback. An instance on a dynamic port could not be
  reached at all. Now `SERVER` + instance name with the port left blank
  connects, the way it does in SSMS.

## [1.26.0] — 2026-09-17

### Added

- **Missing translation keys now fail the test suite.** A key referenced by
  the code but absent from a locale file used to render as the key itself,
  visible only to whoever looked at that button — TypeScript does not check
  `t()`'s argument and nothing mounted every component. `src/lib/i18n/keys.test.ts`
  checks every literal `t("…")` against both locales and that the two carry the
  same keys.

- **An Extensions panel: browse Open VSX from inside the app.** A new occupant
  of the right dock, beside Saved queries, Pulse and the AI panel. Search the
  registry, see what each theme is (icon, author, licence, downloads, how many
  variants it contributes), install it in one click, and apply it — without
  leaving the window. Installing pairs the extension's first light and dark
  variants itself; picking different ones is there for when you want it, not
  before every install. A theme you imported by hand from a `.vsix` is
  recognised in the listing too, and gets update checks, by matching its
  manifest identifier.

  Installed themes are checked for newer versions, and updating one **never
  overwrites a palette you have edited**: the editor theme is refreshed and
  your colours are left exactly as you set them. The panel says which themes
  that applies to before you press anything.

  Some details that are decisions rather than plumbing:

  - **Icon themes never appear.** The registry files colour themes and icon
    themes under the same `Themes` category and its search response cannot
    tell them apart — only each extension's manifest can. HuginnDB fetches
    that manifest (1–11 KB, not the whole package) and filters on it, so
    Material Icon Theme costs 11 KB to discard rather than 6 MB. It also means
    the result count is approximate, and the panel says "about".
  - **Downloads are verified** against the checksum the registry publishes
    beside each package, and refused outright on a mismatch.
  - **The app decides where to connect, not the panel.** The registry URL is
    read from your preferences inside the backend, so turning the browser off
    in Settings → Appearance actually turns it off. You can also point it at
    your own Open VSX instance, and each installed theme remembers where it
    came from, so changing the setting never re-targets an existing theme's
    updates.
  - Nothing of yours leaves the machine: anonymous requests for public
    packages, no credentials, no telemetry, no schema.

- **Import a VS Code colour theme — your editor theme, and an app palette
  derived from it.** Settings → Appearance's **Import theme…** now also accepts
  a `.vsix` extension package or a bare `*-color-theme.json`, alongside the
  `.huginndb-theme.json` exports it already took. Raised by David, whose
  starting point was [open-vsx.org](https://open-vsx.org) — the open registry
  Cursor, VSCodium and Gitpod use, and the correct one: Microsoft's own
  marketplace terms forbid access from products that are not VS Code.

  This release does the conversion, offline. Browsing open-vsx from inside the
  app is a separate piece of work; what lands here is everything underneath it,
  which is the part that decides whether the idea is worth the network code.

  What an imported theme actually does, stated plainly because the two halves
  differ:

  - **The editor gets the theme itself.** Monaco *is* VS Code's editor, so
    `tokenColors` and the `editor.*` colours mean here exactly what they mean
    upstream. Import Dracula and the SQL editor is Dracula, not an
    approximation — down to the translucent selection, which is preserved
    rather than flattened because it is meant to be translucent there.
  - **The rest of the app gets a palette derived from it.** A VS Code theme
    names ~600 keys after the widget each paints (`sideBar.background`,
    `list.hoverBackground`); HuginnDB names 30 after the role each plays
    (`card`, `accent`, `brand`, `pk`/`fk`). That is a reading, not a
    translation, so the import lands as an ordinary custom theme in the
    Appearance editor — every token editable afterwards. The dialog previews
    the derived palette before you commit to it.

  Four things the conversion handles, each found by reading real themes rather
  than the spec:

  - **Theme files are JSON *with comments*, and plenty do not parse without
    that.** Two of the five themes kept as test fixtures (Tokyo Night, Nord)
    fail `JSON.parse` outright.
  - **Translucent `#RRGGBBAA` colours are composited at import**, against the
    theme's own editor background — up to 52 keys in a single theme. They are
    translucent in VS Code because its renderer paints them over whatever is
    behind them; resolving that once at import is what keeps the app's colour
    pipeline unchanged.
  - **Missing keys fall back inside the theme, never to VS Code's defaults.**
    All five sampled themes omit `menu.*`, and One Dark Pro also omits
    `button.foreground`. Borrowing VS Code's own values would put its blue
    focus ring inside a Gruvbox import; each token instead walks a chain of
    related keys the theme does state, ending at something derived from its own
    background and foreground.
  - **A surface that resolves to the page background is pushed one plane
    away.** Four of the five sampled themes do this at least once — Nord's
    sidebar *is* its editor background, GitHub Light's menu and input
    backgrounds are both plain white. Correct in VS Code, which separates those
    planes with a border; here it would mean a panel that is not there and an
    input field with no field. Only an actual collapse is corrected, so a quiet
    separation the theme did state survives untouched.
  - **Every text/surface pair is contrast-checked.** VS Code can rescue a bad
    pair with a per-widget override and this palette cannot, so a theme whose
    hover surface nearly matches its text colour would otherwise ship an
    unreadable selected row.

  One extension is usually several themes — GitHub contributes nine variants,
  Gruvbox six, One Dark Pro five — so the import dialog pairs one light variant
  with one dark one into a single theme family. Choosing only one fills both
  halves with it rather than inventing a palette nobody designed, and says so.

  Imported editor themes appear in Settings → Editor's theme picker and are
  deleted along with the theme family they arrived with.

## [1.25.0] — 2026-09-17

### Added

- **Cell content is formatted the moment you open it — per content type.**
  Settings → Editor grows three switches: auto-format **JSON**, **XML** and
  **SQL** on open. They are independent on purpose, because the types are not
  one want: someone whose columns hold JSON blobs wants those unfolded without
  also having their XML reflowed. Raised by David.

  The **Format** button has been there all along, and the app has always known
  what kind of content a cell holds (`detectLanguage`) — what was missing was
  any way to say "just do it". The app also disagreed with itself: the
  read-only preview panel formatted *unconditionally*, so you saw the value
  pretty-printed, opened the editor on it, and got raw text. All three surfaces
  — preview, modal editor and docked side panel — now read the same three
  switches.

  Four decisions are worth stating:

  - **The automatic path refuses any reformat that changed more than
    whitespace, and that is the reason this is not a three-line change.**
    Pretty-printing JSON means `JSON.parse` + `JSON.stringify`, which is a
    *value* round trip, not a whitespace one: `10000000000000000001` comes back
    as `…000`, `1.0` becomes `1`, duplicate keys collapse, integer-like keys
    are hoisted and sorted, `\u0041` becomes `A`. That has always been true
    behind the Format button, where the click is the user accepting a rewrite.
    On open it would be something else entirely, because the formatted text
    becomes the editor's save baseline — "open the row with the Snowflake id,
    press Ctrl+S, silently write a different number". So the automatic path
    formats, checks that only whitespace outside quoted literals and CDATA
    moved, and discards its own output when it did not. The manual button is
    deliberately left ungated.
  - **The formatted text is the new baseline, not an edit.** Opening a cell
    does not mark it dirty and closing it raises nothing; a parked session
    restored after a tab switch is never re-formatted, and neither is the
    buffer handed over by "move to side panel" — `formatXml` is not idempotent,
    so a second pass would drift the indentation it just applied.
  - **JSON and XML default on, SQL defaults off.** The first two are what keeps
    the preview panel doing what it has always done: shipping them off would
    have taken that away from every existing install rather than being a
    neutral default. SQL is the new capability, and its formatter rewrites the
    statement — keyword casing — so it cannot clear the losslessness check the
    other two are held to, and is offered as an explicit opt-in instead.
  - **SQL formatting follows the connection's dialect**, via the new
    `sql-formatter` dependency (MIT): PostgreSQL, MySQL, SQLite and T-SQL for
    SQL Server, standard SQL where there is no connection to ask. Only those
    five dialects are imported by name rather than the package's twenty-odd, so
    the bundle grows ~109 KB raw / ~30 KB gzipped rather than carrying BigQuery
    and Snowflake along for the ride.

- **"Expand every nested object" — one gesture per document, and one for the
  whole page.** Each card in the grid's list view now carries a chevron beside
  its field count that unfolds (or folds) every nested object in that document
  at once, at any depth; the grid footer carries the same pair for every
  document on the page, beside the column-fit and row-zoom controls that
  already answer "how am I looking at this".

  The per-line chevrons only ever moved one level. A document whose interesting
  values sit two or three levels down — a `processInfo` keyed by device id,
  each entry an object of its own — took one click per level to read, and then
  the same clicks again in the next document. Reading a page of them was not a
  practical thing to do.

  Three decisions are worth stating:

  - **It flips the base the folds are measured against, rather than toggling a
    set of paths.** A container hidden inside a folded ancestor contributes no
    line, so its path is not in the flattened field list and there is nothing
    to toggle — a set-based "expand all" would have unfolded exactly one level
    and stopped. Flipping the base opens the whole tree in one move and costs
    nothing per level.
  - **The grid-wide press is an epoch, not a boolean.** It is an action, not a
    state: after pressing it you may fold one object by hand, and pressing it
    again has to expand that object back. A boolean prop would already be
    `true` on the second press and nothing would happen. It is also what lets a
    card that scrolls into the virtualizer's window *after* the press mount
    already expanded.
  - **Neither control writes the *Expand nested values by default*
    preference.** That one answers "how should a document open"; these answer
    "show me everything in what I am looking at right now". Conflating them
    would make a one-off gesture rewrite a persisted setting.

  The per-document control is hidden on a document with nothing to unfold, and
  its direction follows what is on screen — it reads "collapse" only once every
  visible container is open. The **aggregation preview** carries the pair too,
  floated over the documents instead of in a bar of its own: that surface is
  also a stage card's right-hand pane, where a permanent strip would cost the
  preview rows the pane exists for. It owns its own signal, having no grid
  around it, and hides the control when the pipeline projects only scalars.

- **"Paste rows as JSON…" — bulk row insert on all four SQL drivers.** Behind
  the grid's Insert button, next to the inline draft row. One JSON object is
  one row; paste an array and it becomes a single multi-row `INSERT` inside a
  single transaction. This closes `ROADMAP.md`'s longest-standing open item:
  bulk *delete* shipped in 1.0.2, and MongoDB has been covered since its
  document dialog started accepting an array, but on SQL "here are forty rows"
  had no path short of hand-writing the statement in the query editor.

  The MongoDB dialog this borrows its shape from exists for a reason that
  genuinely does not carry over — a collection is schemaless, so a field the
  grid's sample missed could not be typed at all — and `insert_documents`'
  own docstring says as much. That argument is about *shape*, and it still
  holds. What SQL was missing is **bulk**, which is a different want.

  Four things are worth stating because each had a plausible-looking
  alternative:

  - **A pasted key is not a column name until the catalogue says so.** Keys
    are matched against the table's real columns and the *catalogue's*
    spelling is what reaches the SQL, so nothing user-typed is ever quoted as
    an identifier. An unknown key is refused by name, with the real columns
    listed. Matching is case-insensitive, so a paste from a tool that
    upper-cases its keys just works.
  - **A row whose column set differs from the first is refused**, naming the
    row and both sides of the difference. Unioning the columns and binding
    `NULL` for the gaps looks friendlier and is wrong: it overwrites the
    column's `DEFAULT`, which for a `NOT NULL DEFAULT now()` column turns a
    valid insert into a constraint violation. Grouping rows by their key
    signature is defensible, and was still not chosen first — the usual cause
    of a differing key set is a typo in a key name, and grouping turns that
    typo into a column silently taking its default.
  - **A JSON `true` is stored as `1` in a boolean column and as the word in a
    text one.** That decision reads the column's type rather than the driver,
    which sounds backwards until you notice that `1`/`0` is accepted by all
    four engines' boolean inputs anyway — the case a per-driver rule could not
    have handled is the text column.
  - **A paste too wide for the engine's bind-parameter ceiling is chunked, and
    the chunks share one transaction.** 500 rows × 20 columns is five
    statements on SQL Server (which refuses past 2100 parameters) and one
    everywhere else, and either way the whole paste lands or none of it does.
    The Console shows one entry, because one transaction is one unit of work.

  Omitted columns take their database default and `null` writes a SQL `NULL`,
  matching what the single-row insert has always done. The result reports how
  many rows went in rather than their generated ids: the four engines disagree
  about what a multi-row insert's ids even are — MySQL reports only the first,
  SQL Server only the last — and a count is the one honest answer.

  Not exposed over MCP. The connector already has a structured `insert_row`
  that serves a model better than a text blob would, and every new write tool
  costs three wiring steps the compiler does not check. See
  [`engineering/adr/adr-084`](engineering/adr/adr-084-json-row-insert-catalogue-gated-and-transactional.md).

- **"Query this table…" on a table or view in the schema tree.** It opens a
  query editor already scoped to that relation's connection *and* database,
  seeded with `SELECT * FROM <table> LIMIT 100;`.

  The entry existed one and two levels up — a database node and a schema node
  have had "New query here" for a while — and stopped at the level people
  actually right-click, which is the table they are looking at. Getting a query
  over a specific table meant opening a blank editor and retyping a name the
  tree was already showing.

  Two details are the reason this is not simply `openQueryTab(connectionId)`:

  - It passes `resolveTarget: false`. In a server-wide connection the table
    row's `connectionId` is already the `<parent>::db::<db>` child its subtree
    was mounted for, and the default would hand that to `queryTargetFor`, which
    re-points the tab at whichever database the *focused* tab happens to be on.
    "Query this table" means this table's database.
  - It goes through the explorer's action bundle rather than importing
    `openQueryTab` directly, so it fires the same `onTableOpen` hook opening a
    data tab does and the multi-DB tree's database accent moves with it.

  `selectSnippet` grew an optional row limit for the seed, which also closes an
  asymmetry it had carried since it was written: the MongoDB branch always
  emitted `.limit(100)` and the SQL branch emitted no bound at all. That was
  defensible while the only consumer was "Copy SELECT statement", where the
  user reads the text before running it — it is not defensible for text the app
  puts in an editor for you to run. SQL Server gets `SELECT TOP 100 *`, since
  T-SQL has no `LIMIT` and the `OFFSET … FETCH NEXT` form the executed paging
  path uses additionally requires an `ORDER BY` there is none to supply.
  "Copy SELECT statement" is unchanged — it still copies the bare statement,
  because a snippet you paste and tweak wants no bound guessed for it.

### Changed

- **The grid's "Copy row as ▸ SQL INSERT/UPDATE" and the schema tree's
  "Copy SELECT statement" / "Query this table…" no longer qualify the table
  reference with its schema or database.** They used to emit
  `"schema"."table"` (or `` `db`.`table` `` on MySQL); now it's just
  `"table"`. That qualification made sense before the query editor had a
  connection/database dropdown of its own — a pasted snippet needed to say
  where it belonged, because nothing else did. Now the editor already shows
  and controls which database a query runs against, so the prefix on every
  copy-paste was redundant noise a user had to read past on each paste. Raised
  by David.

- **A shared origin's background sync no longer toasts "N connection(s)
  updated from a shared origin" every time it pulls a change.** The poll runs
  every few minutes and at startup, so on a machine that follows an
  actively-edited shared file the toast fired constantly for edits nobody on
  this machine made — noise indistinguishable from something worth reading.
  The vanished/superseded-secret notices this sweep also raises are untouched:
  those name something the user has to act on (adopt, retire, or notice a
  password changed underneath them), which this toast never did.

### Fixed

- **A MongoDB database node offered "New table".** `DatabaseNodeMenu` — the
  context menu a database node carries in both the single- and multi-DB
  explorers — showed "New table" unconditionally, next to the driver-gated
  "New view" and "New collection" entries right below it. Every other DDL
  action on that menu already checks `supportsDdlEditing(driver)`, which is
  `false` for MongoDB precisely because it has no `CREATE TABLE` to build;
  "New table" was simply missing the same check, so a MongoDB database showed
  both "New table" and "New collection" side by side, and picking the former
  opened a structure-editor tab the driver cannot act on. It is now gated the
  same way its neighbour is.
- **An empty MongoDB collection had no way to insert its first document.**
  The grid's Insert affordance requires a usable primary key
  (`TableDataTab`'s `hasPk`), and on MongoDB that PK is the collection's `_id`
  field — discovered, like every other field, by sampling documents
  (`infer_columns`). A collection with zero documents samples zero fields, so
  `_id` itself never showed up and the grid concluded the collection had no
  PK at all, hiding Insert along with every other PK-gated action. This is
  the same class of bug 1.16.2 fixed for the SQL drivers (#27) — an empty
  relation reporting no columns — but the fix there (`fetch_table_data`
  falling back to the catalog definition) doesn't carry over, because
  MongoDB has no catalog to fall back to: a collection's shape *is* whatever
  its documents contain. `infer_columns` now seeds `_id` by hand when the
  sample comes back empty, since every MongoDB document gets one whether or
  not any exist yet to prove it.
- **With two connections live, the "+" button opened a query tab against the
  wrong one.** The app carried two independent "current" pointers and nothing
  connected them: `useUi.selectedConnectionId` — what the workspace points at,
  and what the tab strip's `+`, the `newQuery` keybinding and the command
  palette's new-query entry all resolve their target from — and
  `useTabs.activeId`, the focused tab, which carries its own `connectionId`.

  Only the *connection* flows ever wrote the first one: connect, reconnect, the
  status-bar picker, the workspace picker, environment restore. Opening a tab
  wrote only the second. So with a MySQL and a MongoDB connection both live,
  clicking a MySQL table in the schema tree and pressing `+` opened the editor
  against MongoDB — the tree never touched the selection at all, so it stayed
  wherever the last *connect* had left it. `queryTargetFor` could not rescue
  this by design: it only ever refines *within* the connection it is handed
  (parent → its `::db::` child) and deliberately discards a focused tab
  belonging to somebody else.

  Clicking an **already open tab** of the other connection had exactly the same
  ending. That half was never reported, because the tree is where people
  notice it — but it is the same missing rule, and it is why the fix is not a
  third `setSelectedConnectionId` call in the schema tree. The command palette
  and the Ctrl+Tab switcher each already carried one, hand-written, which is
  the shape of a rule that wants to live in one place. Focus now *is* the
  focused tab's connection, derived once in
  `src/stores/session/focusFollowsTab.ts`, and the four ad-hoc calls that were
  approximating it are gone.

  The workspace consequently follows the tab everywhere it already read that
  value: the OS window title, the Pulse panel's target, the AI panel, the Saved
  Queries panel and the tree's own hairline highlight. The persisted launch
  state follows too — it now restores the connection of the last focused tab
  rather than the last one connected, which is the same answer in every session
  that ended with a tab open and a better one in the sessions that didn't.

  Two constraints are load-bearing and written next to the code. The tab's id
  is folded through `parentConnectionId` before it is stored, because
  `selectedConnectionId` must name a real profile — `useConnections.active`
  only holds top-level ids, and a `<parent>::db::<db>` selection is cleared one
  render later and replaced with an arbitrary pool. And the subscription hangs
  off the store rather than dockview's `onDidActivePanelChange`, which already
  flows into `useTabs.setActive`; a second dockview↔store path is the thing
  gotcha #010 exists to forbid.

- **The grid's "Copy row as ▸ INSERT/UPDATE" and "Copy with column" snippets
  silently dropped backslashes on MySQL.** `sqlLiteral`
  (`src/lib/grid/copyFormats.ts`) quoted a string value by doubling embedded
  `'` characters but never touched `\`. That is fine for Postgres, SQLite and
  SQL Server, none of which give `\` any meaning inside a plain quoted
  literal — but MySQL does, by default (`NO_BACKSLASH_ESCAPES` is off unless
  the server opts in): a value like `DOMAIN\user` copied out as
  `'DOMAIN\user'`, and pasting that back in and running it against MySQL
  interpreted `\u` as the escape sequence for a literal `u`, so the row came
  back as `DOMAINuser`. The backend's dump path
  (`src-tauri/src/db/dump.rs`) already escaped `\` → `\\` for exactly this
  reason; this clipboard-only generator, built independently in the
  frontend, did not. `sqlLiteral` now takes the driver and escapes `\` first
  (before doubling `'`) when it is `mysql`, matching the dump path; the other
  three drivers are unaffected by construction, and `toSqlInsert`/
  `toSqlUpdate`/`GridRow`'s "Copy with column" all thread the driver through.

- **Switching environments blocked the app for as long as the outgoing
  connections took to close plus however long the incoming ones took to
  reconnect — MongoDB's heavier handshake made this feel like a hang.**
  `useEnvironments.switchTo` closes every pool the outgoing environment had
  open before handing the backend over to the incoming one, and that ordering
  is load-bearing (see gotcha #027 and the doc comment on the `disconnect`
  command: reconnecting before the outgoing pools are actually gone can
  briefly double the connection budget against the same server). A first pass
  made the outgoing teardown itself concurrent instead of one connection at a
  time, which helped but left the two real costs untouched: `switchTo` still
  waited out the *entire* teardown-then-reconnect sequence before
  `EnvironmentSwitchGuard` lifted its inert overlay off the schema tree and
  tab area, so an environment with a slow MongoDB connection on either side of
  the switch stayed sealed for however long that connection took.

  The fix removes the wait rather than shrinking it: `switchTo` now hands the
  backend over to the incoming environment — flipping the active pointer,
  applying its theme/filters/tabs — *before* a single outgoing pool is asked
  to close, instead of after every one of them is confirmed gone. The outgoing
  environment's tree is consequently off screen by the time any real network
  teardown starts, which is what let `EnvironmentSwitchGuard` be deleted
  outright: the race it existed to prevent (a click reopening a pool mid-
  teardown) needs the outgoing tree to still be rendered, and it no longer is.
  The teardown-then-reconnect sequence itself is unchanged in shape (outgoing
  pools close concurrently, reusing the same `disconnectAndClean` helper
  `disconnectAll` uses; only once every one of them is confirmed closed do the
  incoming pools open, still respecting the connection-budget ordering above)
  — it just runs after the user is already looking at, and can already work
  in, the destination environment, with each of its connections showing its
  own "connecting…" state (`useConnections.connecting`, shared with a manual
  click so the two can never race each other) until it comes up.

  Getting the reorder right hinged on one thing verified against the backend
  directly: `save_launch_state`/`get_launch_state`/`save_tab_state` all
  resolve against *whichever environment is currently active*, with no
  explicit environment id in the call. So the outgoing environment's
  definitive final launch state — previously written after its teardown
  loop, as a "last write wins" over each connection's own opportunistic
  write during that loop — now has to be (and is) written *before* the
  handover, from the same values already captured at the top of the
  function; the individual `disconnectAndClean` calls that follow the
  handover pass `persistLaunch: false` so they can no longer write over it
  against the wrong (now-incoming) environment.

## [1.24.0] — 2026-09-14

### Added

- **Each machine chooses what it pulls from a shared origin.** A published file
  carries three independent things — the connections, the environments that
  group them, and the JSON Schema library with its column bindings — and
  Settings → Origins now subscribes to each one separately, per origin, when
  you register it and afterwards under "Edit registration".

  This is the answer to a split that shows up in every team using origins: some
  people want the whole configuration handed to them, others already have their
  environments arranged the way they like and only want the servers. Until now
  the only way to serve both was for the curator to publish a *second*,
  connections-only file — which nothing kept in step with the first, so the two
  drifted apart. Both groups now register the same file and tick different
  boxes, which makes that divergence impossible rather than merely discouraged:
  there is one document, and the publisher always publishes the superset.

  Splitting the document itself was considered and rejected. It would have kept
  the two files and added a cross-file reference that can break, a second
  concurrency domain with no transaction over the pair, and an ownership
  question `ConnectionProfile.origin_id` — a single field, and the whole
  ownership model — cannot answer.

  The form previews what the file actually holds before you choose, so a
  subscription to "environments" is not a guess about whether it publishes any;
  a plain connection bundle offers only the first box, since that is all it can
  contribute. Two combinations are allowed and explained rather than forbidden,
  because each is correct for somebody: environments without their connections
  mirror as empty, and JSON Schemas without their connections land every binding
  disabled.

  **Unticking a box never deletes anything.** What a wider subscription already
  brought in stays linked to the origin and read-only, and simply stops being
  refreshed. Releasing those into ordinary local entries remains a separate,
  deliberate step — and an irreversible one, since a detached connection is
  yours from then on and the origin will not adopt it back.

  An origin registered before this existed keeps pulling all three, and that
  default is load-bearing rather than convenient: this flag describes what an
  origin was already doing, not a permission, so a closed default would have
  narrowed every registered origin on update and made the next sync report the
  user's entire configuration as vanished. See
  [`engineering/adr/adr-083`](engineering/adr/adr-083-origin-consumption-scope-defaults-open.md).

### Fixed

- **MongoDB databases can be dropped, and a server with no databases is no
  longer an empty panel.** Two halves of the same mistake, both at the root of
  a cluster-level connection.

  The tree's "Drop database…" entry was gated on `supportsCreateDatabase`, so
  MongoDB — which has no `CREATE DATABASE` wire command, because the server
  does not store an *empty* database — was also denied the ability to delete a
  full one, even though `dropDatabase` is a single command it has always
  supported. One predicate was answering two questions; they are now
  `supportsCreateDatabase` and `supportsDropDatabase`, and the backend's
  MongoDB arm runs the drop instead of returning "isn't supported here". It
  checks the database exists first: `dropDatabase` against a name that is not
  there reports success, which would have confirmed a typo back to the user as
  a deletion.

  Dropping a database also stopped reading the `ui.confirmDestructive`
  preference. Turning that off is a reasonable thing to do when the prompt is
  about deleting a row you can re-insert; it was never meant to mean "drop a
  database on one menu click with nothing in between", and `confirmIrreversible`
  — which exists for exactly this and which `DROP TABLE` already used — is what
  this should have been calling.

- **Creating a database works on MongoDB, which is what the empty tree needed.**
  Since an empty MongoDB database does not exist on the server, "New database"
  there asks for the first collection too and creates both, the same pair
  Compass asks for. `create_database` takes one optional `initial_collection`
  rather than splitting into two commands — the intent is one intent, and
  splitting it would have moved the per-driver branch into the frontend — and
  the SQL drivers reject it rather than ignoring it.

- **A single-DB connection has a database node, and it is where the database's
  own actions live.** The other half of the same asymmetry, and the one that
  was actually reachable: a profile with a `database` set showed no database
  node at all — its top node is a *schema* — so "Drop database…", which lives
  on a database node, existed nowhere, while "New database" sat in the
  connection's menu. You could create a database from a connection and then
  have no way to delete it from anywhere in the app.

  The fix is the node rather than one more entry on the connection: a user who
  wants to delete a database goes to the database. What that means per driver
  is the part worth stating, because the tree's top node only *sometimes* is
  the database. MySQL and MongoDB report a single schema named after the
  database itself, so the two merge into one node — no extra level, nothing
  nested under itself — and that node carries the database menu. Postgres and
  SQL Server report `public`/`dbo` inside a database the tree had never drawn,
  so the database node appears above them, where it belongs. SQLite gets
  neither: its file *is* the database.

  Both modes now render the same menu from the same component
  (`DatabaseNodeMenu`), including "New collection", which had been on the
  connection for the same want-of-anywhere-else reason. The two modes differ
  only in what they have to resolve first — multi-DB opens a synthetic
  per-database pool, single-DB is already bound — and in the aftermath of a
  drop, which is why that stayed a prop.

  **The four engines disagree about dropping the database you are connected
  to, and all four are handled rather than three being left to fail.** MySQL
  and MongoDB simply allow it. PostgreSQL refuses categorically — a session
  cannot drop its own database, and the server also refuses while *any* session
  is attached, so issuing the statement from elsewhere is not enough on its
  own: the pool is closed first and the statement runs over one short-lived
  connection to the `postgres` maintenance database, built by cloning the
  pool's own `PgConnectOptions` (same host and port, SSH tunnel's local
  listener included, same credentials and TLS mode, and no second trip to the
  keychain). SQL Server refuses while the database is in use, which the pool's
  own idle sessions are enough to trigger, so the checked-out session moves
  itself to `master` and the rest are closed — via a new `MsSqlPool::close_idle`
  that leaves the pool able to reopen, because a refused drop must not also
  leave a dead connection behind.

  The connection is disconnected afterwards whether the drop succeeded or
  failed: by then its pool is closed or its default database is gone either
  way, and a connection left marked active would fail every later command with
  something far less legible than the error the user just read. The saved
  profile is deliberately untouched — it points at a database that no longer
  exists, which the toast says out loud, and deleting saved configuration and a
  keychain entry is a bigger decision than the one the user made.

- **A connection whose server has no databases now says so.** It rendered
  literally nothing: no row, no sentence, which reads as a connection that
  failed rather than a server that is empty, and left creating the first
  database as something the user had to already know was hidden in the
  connection row's context menu. The tree now distinguishes the two reasons it
  can be empty — a server with no databases, which offers "New database", and
  every database hidden by the visible-databases subset, which offers the
  picker instead.

### Changed

- **The schema tree's rows are one primitive now.** Four call sites had
  hand-written the same `<button>` — full width, the same padding, the same
  `hover:bg-accent`, and the same focus ring driven by "is my context menu open
  on me". `ui/tree-row.tsx` owns that chrome and each row keeps its own
  content, which is the part that actually differs. Two entries leave
  `uiAdoption.test.ts`'s raw-button budget (136 → 134).

- `commands::schema::create_collection` validates through the same
  `validate_collection` every other MongoDB collection-level write already
  used, instead of its own inlined copy of two of its three checks. The shared
  one also gained the `$`/NUL check, which none of them had.

## [1.23.0] — 2026-09-11

### Added

- **A results panel per statement that returns rows, instead of only the
  last.** Running a script of several `SELECT`s (or several `.find` /
  `.aggregate` on MongoDB) showed exactly one grid: the backend built a
  complete result set for every one of them and each overwrote the previous in
  a single `last_result` field. Every statement now carries its own, and a
  strip above the grid picks which is on screen — `#1 · 120 rows`,
  `#2 · 8 rows` — while statements that return nothing keep reporting in the
  batch summary line, where a write's affected-row count and the statement
  that stopped the batch belong. A run that fails halfway keeps every panel it
  produced before the failure.

  **SQL Server gains result sets it was already fetching and discarding.** One
  T-SQL statement can legitimately return several, and the batch runner kept
  the first non-empty one — a reasonable thing to do when there was one grid to
  put it in, and a silent loss once there is a panel per result. A statement's
  result sets are therefore a list rather than a single result, labelled
  `#2.1` / `#2.2` when there is more than one.

  **The row cap is now a budget shared by the whole batch.** `MAX_ADHOC_QUERY_ROWS`
  (50 000) bounds one statement, which was the entire story while a batch
  returned one result set; keeping every statement's would have made a
  ten-`SELECT` script ten times that ceiling, over IPC and in the DOM, which is
  exactly the out-of-memory the cap exists to prevent. A batch now keeps the
  same 50 000 rows one statement may, handed out in statement order: a
  statement that runs into what is left keeps the rows that fit and is marked
  truncated, the same flag and the same wording as overrunning the
  per-statement cap. Its reported row count is untouched — shedding rows from
  the grid must not make the summary claim a `SELECT` returned nothing.

  Only the selected panel's grid is mounted. That is a deliberate trade rather
  than an optimisation deferred: `gridSelection` is keyed by tab id and the
  docked cell editor takes the tab id as its owner, so two live grids in one
  tab would overwrite each other's selection count and fight over the editor.

  `BatchResult.last_result` is gone. With a result set on every statement it
  was a second, full copy of the largest payload in the batch crossing the IPC
  boundary for a consumer that no longer exists — the SQL import dialog and the
  MCP write path only ever read `statements` and `total_affected`.

- **Two theme tokens the dialog work needs, landing ahead of it.** `--scrim` is
  the wash painted between the app and an open dialog. It was `bg-black/60` — a
  *literal* black, hard-coded in the only two places the modal stack is built
  (`ui/dialog.tsx`, `shell/OverlayPalette.tsx`) — and so the one point where
  that stack escaped the theme system entirely: a light theme got a blackout
  rather than a dim, and the warm presets got a cold one. Each of the ten
  built-in colour blocks now states the darkest neutral it already owns (its own
  `background` on a dark surface, its own `foreground` on a light one). It is
  deliberately kept out of `COLOR_KEYS`, like `pk`/`fk`/`numeric`: a system
  surface, not a colour to edit in Appearance. The alpha is **not** in the token
  — `applyTheme` runs every value through `hexToHslColor`, so an `rgba()` would
  not survive — it lives in the utility and differs by mode, because one alpha
  cannot both dim a white page and darken an already-dark one.

  `shadow-island` is the workspace island's lift, promoted from the
  hand-written string that lived inline in `IslandShell.tsx` (now its first
  consumer rather than its owner). It is deliberately flatter than
  `elevation-3` and far lighter than `elevation-4`, because an island sits *on*
  the trench rather than floating over it — which is exactly what a full-screen
  dialog will need to borrow to read as that island lifted out, instead of as a
  foreign card dropped on top.

  Nothing renders differently yet: this is the token layer for the dialog and
  tab-chip redesign, split out so the change that spends it is reviewable on its
  own.

### Changed

- **Dialogs now have three anatomies (`prompt`/`panel`/`workbench`) instead of
  one, and the tab strip is coupled to its panel instead of floating chips over
  a trench.** `DialogContent` picks a `tier`, and `DialogHeader`/`DialogBody`
  (new)/`DialogFooter` read it from a private context — a call site says one
  word and can no longer re-declare the header rail, the body padding, the
  radius or the close button's gap, which is exactly what seven hand-copied
  header rails (five spellings between them) used to invite. `prompt` (8px,
  the tab chip's own radius) is the ~11 one-line confirms; `panel` (10px, the
  island's own radius, and the default) is the ~18 forms; `workbench`
  (edge-to-edge, borrowing the workspace island's border/fill/`shadow-island`)
  is Settings, the connection manager, the shared-origin editor, Documentation,
  and the cell editor's fullscreen mode. `DialogActions` drops its `size` prop
  (buttons are always `sm` now, settling a divergence half the app's footers
  had already resolved one way and half the other) and Cancel converges on a
  ghost button everywhere.

  The tab strip's active chip now merges into the panel below it: a top-only
  radius, its bottom seam painted over instead of cut across by the strip's own
  divider, no fill on inactive chips, and no drop-shadow lift — a coupled tab
  doesn't also float above the surface it belongs to. The strip itself steps
  from 42px to 38px. Per-tab colours and `Preferences → General`'s three accent
  styles (cap/rail/boxed) are unaffected.

  `window.confirm` is retired in favour of an in-app confirm dialog
  (`ConfirmHost`) that matches the rest of the app's theme instead of showing
  the OS's own unstyled prompt — the ten places that used to freeze the window
  on a native dialog (dropping a database, an SQL import, an index rebuild, an
  MCP-sidecar warning before installing an update, among others) now show a
  themed one instead, with the same wording and the same "type to confirm"
  safety gate they had before.

### Fixed

- **The results grid cut off its last rows, with no way to scroll to them.**
  `DataGrid`'s root is `h-full`, so its height is `100%` of whatever it is
  dropped into. The query tab's results area and the view editor's data preview
  dropped it straight onto a flex line that already held a header — the batch
  summary and the result-tab strip in one case, the preview title in the other —
  so that `100%` resolved against the *whole* panel and the grid hung below its
  container by exactly the height of its siblings. The panel clipped the
  overhang, so the grid's own scroller reached an end the user could not see:
  the final rows were unreachable and no scrollbar said so. Both now hand the
  grid the same `flex-1 overflow-hidden` box `TableDataTab` always did.
  Measured on the reported case, the last row sat 48px past the visible edge.

  A source contract (`uiContracts.test.ts`, rule K) now requires every
  `<DataGrid>` call site to sit in such a box. This is pure layout — nothing
  type-checks it and jsdom cannot see it — and it had already shipped twice,
  including in the view preview, where the header made it true from the day it
  was written.

- **A leading comment made a MongoDB statement unrunnable — and, worse, invisible
  to the write guard.** `shell::parse` trimmed whitespace and a trailing `;` and
  then required the text to start with `db.`; it never skipped comments. So
  `// note` above a statement was rejected with "MongoDB statements must start
  with `db.`" — the failure a new query tab used to hit on its own seeded hint,
  and the one anybody writing a note (or pressing Ctrl+/, which inserts `//`
  there) still hit. Both forms, `//` and `/* … */`, are now skipped, by one
  helper shared with `looks_like_mongo` so the two cannot disagree about where a
  statement begins.

  That sharing is the security-relevant half. `looks_like_mongo` is what routes
  a statement to the Mongo classifier in `db::classify`, so a commented
  `db.users.deleteMany({})` answered "not Mongo", fell through to the SQL
  classifier — which has never heard of `deleteMany` — and slipped past
  `is_unfiltered_write`, the whole-collection-delete guard the MCP connector
  refuses at every tier. The identical statement without the comment was
  refused. Both are refused now.

- **A new MongoDB query tab failing on its very first run, because of the hint
  it seeded itself with.** The tab opened holding
  `// db.collection.find({}) — press Ctrl+Enter`, and `shell::parse` trims
  whitespace and a trailing `;` and then requires the statement to start with
  `db.` — it does not skip comments. So running the buffer as it arrived was
  rejected with "MongoDB statements must start with `db.`", and deleting the
  hint was what made the tab work. A Mongo tab now opens empty. The SQL seed is
  a `--` comment and stays, because every SQL engine here skips one.

  This removes the symptom, not the underlying asymmetry: a `//` note written
  by hand above a statement — which is exactly what Ctrl+/ now inserts in that
  tab — still fails the same way, and `looks_like_mongo` still reads such a
  buffer as not-Mongo at all. Teaching `shell::parse` to skip leading comments
  is the real fix and is deliberately not folded in here.

- **The query tab's autocomplete on a MongoDB connection, which was SQL's.**
  The editor asked Monaco for the `"sql"` language literally, with no driver
  branch anywhere in the file except the status-bar label — so a Mongo tab got
  SQL's Monarch grammar, SQL's comment configuration (`--`, which is why a
  `//` note tokenised as an operator and Ctrl+/ inserted a `--` the Mongo
  grammar does not know), SQL's `;` splitter, and a flat
  suggestion list with no trigger characters. Typing `db` produced an *empty*
  widget: `"db"` is in no catalogue, so Monaco fuzzy-matched it against ~70
  unrelated items and matched none.

  A MongoDB connection now gets its own editor language, `mongodb-query`, with
  a grammar that colours the shell (the `db` handle, method calls, BSON
  constructors, and a `$`-prefixed string as a field reference rather than
  text) and a completion provider that understands the chain rather than
  offering a word list: `db.` offers **collections**, `db.<collection>.` the
  **methods** the backend parser accepts — inserted as runnable snippets
  (`find({})`, not a bare `find`) and marked when they write — a closed call's
  `.` offers exactly the **four cursor modifiers** and nothing else, and inside
  an argument list it offers **field names** plus the operators that fit the
  call: query operators in a filter, update operators in an update document,
  and the whole aggregation stage/accumulator/expression catalogue inside
  `aggregate([…])`.

  Two supporting changes fall out of it. The statement splitter grew a
  **dialect**: under `mongo` the line comment is `//`, `--` is not a comment,
  backticks are not identifier quotes, and `$` no longer opens a Postgres
  dollar-quoted body — previously a `$gt` … `$lt` pair looked exactly like one
  and swallowed every `;` between them, and a `;` inside a `//` note split the
  buffer so the "▶ Run" lens anchored on the comment line. And the query
  tab now warms the schema itself (`useEnsureSchemaLoaded`) instead of relying
  on the user having expanded the connection in the explorer first, so a
  freshly opened tab has its tables — or collections — from the start. Fields
  stay lazy and are sampled at most once per collection per session.

  The catalogue the suggestions come from is a hand-maintained mirror of
  `src-tauri/src/db/mongo/shell.rs`, kept in one file (`lib/mongo/shellCatalog.ts`)
  and shared with the aggregation editor's constructor list, so the two cannot
  drift apart. Nothing in the frontend parses the statement: a cursor scanner
  reports where the caret is, and the one parser stays in Rust.

- **The dialog open/close animation, which had been silently broken since
  shadcn's default `Dialog` was adopted.** Every dialog centred itself with a
  `transform`, and the fade/zoom animation also writes to `transform` for the
  200ms it runs — one replaced the other, so every dialog actually entered
  from the viewport's top-left corner rather than its own centre. Centring now
  lives on a wrapping layer instead of the dialog's own `transform`, which also
  means a dialog taller than the screen scrolls instead of being clipped at
  both edges, and the command palette / tab switcher overlay gains the closing
  fade it never had.

## [1.22.0] — 2026-09-10

### Added

- **MongoDB: the advanced filter can reach inside a document.** A condition
  could only ever name a top-level field, while the list view two panels away
  was already rendering, typing and editing every nested one — so
  `customData.format` was something you could see and edit but not filter on.

  The field control on a MongoDB collection is now a searchable combobox that
  lists the nested paths found in the page you are looking at, each one under
  the field it belongs to and labelled with its BSON type: pick `stats.count`,
  or `items.sku` to match *any* element of an array of subdocuments. Type to
  filter the list, arrows and Enter to pick, and — because those paths are a
  sample of the loaded page rather than a catalog — you can simply type a path
  the list does not hold, for a field only older documents carry. The same
  picker serves the "match" half of Bulk update, so the two dialogs cannot
  disagree about what is filterable.

  Every operator works on a nested path, values are still coerced to the type
  the field really holds (a `long` compared against a `long`, not a string),
  and nothing about the saved filter changes shape — a dotted field name is a
  path the moment the Mongo query builder sees one.

- **The assistant starts with the map, and with whatever you tell it.** Two
  answers to the same complaint: given tools and nothing else, a model fixes on
  whichever table your question named, because as far as it knows nothing else
  exists.

  **Every agent turn now opens with the table list**, read once before the
  first model call. Names only — eighty of them cost a few hundred tokens,
  while eighty table structures would fill the context and leave no room for
  the question — and with the two sentences that make a list more than trivia:
  that it is the whole surface, and that a neighbouring table may be the one
  the question is really about. The Console shows how much preamble went out.

  **And Settings → AI has a notes field per connection**: "What the assistant
  should know". This is the context no tool can discover — that `cfg_*` is one
  row per tenant, that `status` uses an old system's codes, that the table
  everyone asks about is the one with the least obvious name. You write it once
  and it is sent with every question about that connection, agent turns and
  assisted tasks alike, labelled as yours so the model weighs it as knowledge
  about the database rather than as one more thing it read. Two thousand
  characters, truncated out loud past that. Local to this machine and preserved
  across a shared-origin refresh, like the two switches above it.

- **A guide for the AI panel, in the app and in the repo.** Help →
  Documentation gains an **AI panel** page (English and Spanish, like every
  other doc here) that answers the two questions the feature actually turns on:
  where the model runs, and whether it may see rows. It carries the coupling
  table for those two switches, what leaves your machine in each configuration,
  a hardware table for picking a model your GPU can hold, the shared-endpoint
  pattern for a team with one GPU box, the three outcomes of the capability
  check, and the known rough edges — including the fact that a small model will
  sometimes write a `SELECT` and wait for you instead of reading the table
  itself.

  It ends by pointing anyone who already pays for Claude or ChatGPT at the MCP
  connector instead: a subscription is not available to third-party apps, and
  the connector is the sanctioned way to spend a licence you already have.

  `PRIVACY.md` was updated in the same pass, because this feature changes the
  answer to the question that document exists to answer: the inference endpoint
  you configure joins the list of hosts HuginnDB contacts, conversations are
  recorded as living nowhere but memory, and a provider API key is recorded as
  living in the OS keychain and nowhere else.

- **Agent mode: the assistant looks things up on its own.** Switch it on in
  Settings → AI and plain chat stops being blind — it lists the tables,
  describes the ones it needs and answers from what it actually read, rather
  than from what it guessed.

  **It refuses to run on a model that cannot do it.** Agent mode is a
  measurement away, not a preference away: the endpoint check has to come back
  tool-capable, and if it has never run, one runs before the loop does. A small
  model asked to chain tool calls does not degrade gracefully — it fabricates,
  and the assistant looks like it is working right up to the point where nothing
  it claims to have read was ever read. Assisted mode is what everyone else
  gets, and for its four jobs it is *better*, because the context was chosen
  deliberately rather than discovered.

  **Every step is in the Console**, under its own AI filter: the tools it was
  offered and whether they included row access, each call with its arguments,
  and each result's row *count*. The payload never is — that is the data the
  metadata-only guarantee is about, and writing it into a panel you can copy out
  of would be an odd way to keep the promise. This is the part that makes the
  guarantee checkable instead of merely stated.

  Three hard budgets bound a turn: six model calls, twelve reads, and the row
  cap every tool already carries. Hitting one ends the turn and says so in the
  answer, because "the model gave up" and "the model was cut off" are different
  facts and only one is worth retrying. Stop still aborts the request rather
  than the rendering — between two tool calls it ends the turn instead of
  letting the next one start.

  It still cannot write. The tools are read-only, no write is in the catalogue
  at all, and a `run_query` carrying anything but a read is refused with an
  instruction to propose the statement instead.

- **The assistant can read your database now, when you ask it to.** Four jobs
  whose context HuginnDB assembles itself, each one model call with no tool
  loop — which is what makes them work on a model far too small to be trusted
  with one.

  Right-click a statement in the query editor for **Explain this statement** or
  **Why is this statement slow?** (the second hands the model the server's own
  plan). Right-click a table in the schema tree for **Document with AI**:
  columns, indexes, and — only when the endpoint may read rows — a handful of
  sample values. Pulse's slow-statement rows carry the same question, where the
  statement, its timings and its plan are all already on screen. And in the
  panel's composer, the wand writes SQL for whatever you typed, against the
  structures of the tables your request appears to be about.

  Plain chat still reads nothing: it has no tools until the agent loop lands,
  and its prompt says so rather than letting a model invent a schema and
  present it as read. These four are the ones that look, and every read they
  make lands in the Console beside your own statements — an assistant whose
  reads are visible is one you can believe about what it did *not* look at.

  The row rule holds throughout. Documentation is the only job that reads rows,
  and under a metadata-only endpoint it does not become unavailable: it drops
  the sample and the prompt tells the model to say nothing about values it was
  not shown.

- **The assistant panel, in the right dock.** A third occupant beside Saved
  Queries and Pulse, with its own width, its own activity-bar entry and a View
  menu entry you can bind a shortcut to. Off until you switch it on in
  Settings → AI.

  What it does today is talk, and propose statements. A conversation is kept
  **per connection** — the assistant is about a database, and a thread that
  followed you onto a different server would answer about the wrong data with
  total confidence — and it streams token by token, with a stop button that
  actually aborts the request rather than just stopping the rendering.

  The composer carries the two knobs that change an answer: a model picker fed
  by the endpoint's own `/models` list, and the effort track described below. A
  badge in the header says whether the assistant may see **rows** or **metadata
  only** for this connection, and it says so on the screen where you are
  working rather than only in Settings — a guarantee nobody can see is a
  guarantee nobody has reason to believe.

  **Nothing it proposes runs from the chat.** A statement arrives in a small
  read-only editor with an "open in editor" affordance per statement, which
  hands it to a query tab: every guard already lives there, the result has a
  grid to land in, and a write is something you see before it executes. That is
  the posture, not an unfinished feature.

  **Nothing is written to disk.** The transcript lives and dies with the
  session, which is deliberate: it holds schema names, proposed SQL and — once
  the tool loop lands — row snippets, which is exactly the sensitive artefact
  this feature promises not to accumulate. The only thing persisted is whether
  tool cards start expanded.

  Two honest limits while the rest is built. The model has **no access to your
  database yet** — the tool loop is the next piece of work — so the panel tells
  it so, in as many words, because a model with no tools asked "which tables
  are there?" will otherwise invent an answer and present it as read. And the
  tool-call cards are wired but nothing produces them yet; when they do, each
  will name the tool, its arguments and how many rows came back, because that
  count is what tells you whether data left the machine.

- **Settings → AI: the configuration for the in-app assistant, off by default.**
  The panel itself is still being built (`docs/AI_ROADMAP.md` phase 4); what
  lands here is everything that decides what it would be allowed to do, so the
  answer to "what leaves my machine" exists before anything can leave it.

  Two independent axes, because conflating them is the mistake this design is
  built to avoid. **Where inference runs** is a trust level the user *declares* —
  loopback and RFC1918 only pre-fill the guess, and nothing is ever inferred
  from a hostname, since DNS is not a security boundary. **What enters the
  model's context** is separate: a trusted endpoint may read rows, an untrusted
  one gets table and column names, types, indexes and `EXPLAIN` output only,
  unless a particular connection opts in. "Read-only" was never the same promise
  as "nothing leaves" — a read-only assistant running
  `SELECT * FROM patients LIMIT 50` has sent fifty patient records to whatever
  endpoint is configured.

  Reach is per connection and off on every existing profile, as is row access;
  both are strictly local, preserved across a shared-origin sync and cleared on
  import, because what a language model on *this* machine may read is not a
  decision a publisher two machines away gets to make. Any OpenAI-compatible
  endpoint works — Ollama, LM Studio, `llama-server`, vLLM, or a cloud provider
  with your own key — and plain `http` is allowed on purpose, because one GPU box
  serving an office LAN is the deployment this feature is designed around. A
  BYOK key goes to the OS keychain, keyed to that endpoint's host so editing the
  URL cannot send it elsewhere, and no command ever reads it back.

  "Test endpoint" measures what the model can actually do rather than assuming:
  small models asked to call a tool often answer in prose instead, and an agent
  loop over one is not a degraded feature but a broken one. The verdict —
  tool-capable, chat only, or unreachable with the server's own reason — is shown
  verbatim, and agent mode says so when the measured model cannot drive it.

  An **effort** control, because nearly every model on the current local
  library is a thinking model and left alone it spends a paragraph of reasoning
  before the first useful token — which in a chat panel reads as a hang. It sits
  in the composer as well as here, as a track with five stops running from
  faster to smarter, because the choice is an ordered trade-off and a list of
  six equal-looking words says none of that. *Automatic* is a switch rather than
  a sixth stop, since it is not less effort: it sends no `reasoning_effort` at
  all, which is the only setting a strict server cannot reject — OpenAI refuses
  the field outright on a model that does not reason. For a local model in
  assisted mode, turn effort off. And whatever the server does with the field,
  reasoning that arrives inlined in `<think>` tags is stripped from the message
  rather than rendered as prose.

  The panel's own copy points at Settings → MCP for anyone who already pays for
  Claude or ChatGPT: those subscriptions cannot be spent through HuginnDB, and
  the connector is the sanctioned route.

- **A publisher can send a corrected connection back to the shared origin
  without reopening the editor.** Saving an origin-owned connection on the
  machine that publishes it now offers to publish that one row. Until now the
  local fix and the shared fix were two expressions of one intent, separated by
  Settings → the origin editor → find the row → flip its secret to "from the
  keychain" → publish; for a rotated password, everybody pulling from the origin
  stayed locked out for the length of that detour, and the detour was easy to
  forget entirely.

  It is the same write path as the editor's, with one row pre-filled — the
  publisher-role check, the write probe, the content-hash conflict check, the
  `.bak` and the impact report are all the ones a full publish gets, and a
  concurrent publish still refuses and hands the newer document over (the prompt
  opens the editor on it, because merging is a document-shaped job). Crucially,
  a secret that did not change travels byte for byte: correcting a port
  re-encrypts nothing, so it costs nobody the ~600 000 PBKDF2 rounds a fresh
  envelope would, and only a password the user actually retyped is resolved from
  the keychain again. The prompt survives the connection dialog closing, since
  "fix the password, connect, done" is the flow a rotated credential really
  produces.

- **A consumer can keep their own password for a connection a shared origin
  publishes, until the publisher catches up.** The failure mode a shared origin
  has always had is that a server resets a password at 9am and everyone is
  locked out until one person republishes. The only thing to do about it was
  retype the password on *every single connect* — `connect` takes one ad-hoc and
  persists nothing, and saving an origin-owned profile is refused because the
  next sync would undo it.

  "Keep password here" in the read-only banner stores it in this machine's
  keychain and marks the connection as running on it. Deliberately narrow: it
  covers the secret and nothing else, so host, port, database and the rest stay
  the file's to dictate — that is what "somebody curates this" means, whereas a
  password that no longer works is a fact about the server rather than a
  curation decision. And it expires by itself: the override holds while the
  origin keeps publishing the same encrypted secret it was raised against, and
  the first sync that brings a different one lands the published password and
  says so. "Use the shared one" ends it early. A passphrase rotation re-encrypts
  every envelope without changing any password, so it expires every override on
  that origin — reported, not silent.

- **MongoDB URI options the form does not model are now carried through it
  instead of banishing the connection to raw-edit mode.** `retryWrites`, `w`,
  `tls`, `replicaSet` and anything else ride along untouched while host, port,
  database, user and auth source stay editable as fields — so the URI the Atlas
  console gives you opens as a form, which it never did before.

### Changed

- **Turning "edit connection string" back off no longer silently refuses.** A
  URI the form genuinely cannot hold — an SRV cluster, a multi-host seed list, a
  password written into the string, or something that will not parse — used to
  flip the switch back with nothing on screen explaining it, which made raw-edit
  a one-way door: a profile saved from a pasted string could never be edited as
  a form again. It now asks, naming each thing that folding would discard, and
  keeps whatever was legible.

### Fixed

- **Answers hallucinated less, and you can now check the ones that do.** Every
  request asks for a low sampling temperature. Ollama's and llama.cpp's own
  default is **0.8** — a creative-writing setting for an assistant whose job is
  reporting what a table contains, and the mechanism by which a plausible column
  name that does not exist beats the one that does. It is not sent when you have
  chosen a reasoning effort, because OpenAI's reasoning models reject the two
  together.

  Sampling only lowers the rate, so the panel also makes a claim checkable:
  **a tool card now opens to show what came back.** Rows render as a table —
  with a JSON value kept as JSON rather than as `[object Object]` — and anything
  else as indented JSON. A `run_query` card carries a button that opens that
  exact statement in a query tab, where the grid, the pager and your own edits
  are. And the card's badge reads "20 of 41,892" rather than "20 rows" when the
  reply carried the table's real total, because a sample read as a population is
  a specific way for an answer to be wrong.

- **A value that is JSON or code is now shown as a code block even when the
  model forgets to fence it.** On a configuration database most of the
  interesting columns hold a JSON document or a snippet of pseudocode, and a
  400-character object pasted into the middle of a sentence is unreadable
  however correct it is. Valid JSON is hoisted out and pretty-printed; a
  multi-line bracketed block that is *not* valid JSON — pseudocode, a template,
  JSON with unquoted keys — is kept verbatim as preformatted text. A short blob
  or a mongosh filter mid-explanation stays in the sentence it belongs to. The
  prompts ask for the fence as well, in both agent mode and "Document with AI";
  this is the half that does not depend on the model complying.

- **The assistant no longer needs to be talked into running a query.** Even
  after the four fixes below, some models end a turn by writing a `SELECT` and
  waiting for you — with a `run_query` tool in hand and nothing stopping them.
  Agent mode now catches that specific shape: an answer that hands you a
  **read**, in a turn that read no rows, on a connection where rows are
  allowed. It asks the model for that one call and answers from the rows it
  returns.

  At most once per turn, so a stubborn model costs one extra step rather than
  the whole budget; never for a statement that writes, because handing those to
  you is the assistant's job and not a failure; and never when the endpoint is
  metadata-only, where proposing a statement is the correct behaviour. The extra
  step appears in the Console like every other, under the AI filter.

- **The assistant wrote out queries and waited for you instead of running
  them.** It had started picking its tools on its own, and then stalled at the
  last step — printing a `SELECT` and asking you to run it, in agent mode, with
  a `run_query` tool in hand. Four causes, all ours:

  **It was never told which engine it was talking to.** Nothing in the prompt
  named the driver, so it wrote whichever dialect it had seen most — `LIMIT`
  against SQL Server, backticks against Postgres, SQL against MongoDB — and one
  failed call is enough for a small model to stop trusting itself and hand the
  statement over. Every turn now opens with the connection's name, its engine,
  its database, how that engine quotes identifiers and how it pages.

  **`DESCRIBE` was classified as a write.** It is how a model asks MySQL for a
  table's shape, and it was refused as a mutation with an instruction to give it
  to you. `DESCRIBE`/`DESC` and a leading `(` — as in `(SELECT …) UNION
  (SELECT …)` — are recognised as the reads they are. The editor gains the same
  fix: `DESCRIBE t` there used to report a row count instead of showing the
  columns.

  **One refusal served three different problems.** A write, a two-statement
  batch and a `USE` all came back with "present the statement to the user as a
  proposal" — the loudest instruction in the loop. A batch is now told to send
  one statement, a `USE` is told the connection is already open on its database
  and to qualify the name instead, and only an actual write is told to propose
  anything.

  **A MongoDB connection opened at a database did not work at all.** Those carry
  a synthetic id with no connection profile of its own, so every tool call came
  back "no connection named …". It resolves to its parent now, and the database
  you had open becomes the default target rather than being discarded.

- **A write could hide behind a read.** `SELECT 1; DELETE FROM t` was classified
  by its first keyword, so it passed as a read — for the AI panel, which never
  writes, and for a `read-only` MCP connection. Whether the `DELETE` then ran
  was down to the driver: rejected by the prepared protocol on PostgreSQL and
  MySQL, executed by a T-SQL batch and by SQLite. A statement's tier is now the
  strictest tier of every statement in the text, with semicolons inside string
  literals, quoted identifiers, comments and Postgres dollar-quoted bodies
  correctly ignored. Several reads in one string are still a read.

- **The clear button in three search fields showed a raw translation key.**
  `common.clear` was referenced by the search boxes in Settings → MCP and
  Settings → Pulse and by two connection dialogs, and existed in neither locale,
  so the accessible label read `common.clear` to a screen reader in both English
  and Spanish.

## [1.21.5] — 2026-09-07

### Fixed

- **A MongoDB connection that could not be reached reported itself as
  connected.** Pointing a MongoDB profile at a host that is down, a wrong port
  or a dead SSH forward produced a green "Connected" notification, and the only
  trace of the failure was a red line inside the schema tree — which is not even
  drawn unless that connection's row is expanded, and disappears entirely while
  a tree filter is running. Three minutes later the keepalive would notice and
  offer to reconnect, which was the first true thing the app had said about it.

  Two causes, and both had to go. MongoDB's driver builds its client without
  touching the network, and unlike the other four drivers nothing pinged
  afterwards — so `connect` could not fail, and the real error was born eight
  seconds later in the first schema read. And a failed schema read was recorded
  on the connection rather than reported, so the code that had just opened the
  connection could not tell it had failed and went on to announce success.

  MongoDB now checks the server at connect time, like PostgreSQL, MySQL, SQLite
  and SQL Server already did, so a connection that cannot work fails where you
  asked for it — naming the connection, with the driver's own message and a
  button to copy it. A schema read that fails later is reported too: a whole
  connection, a table's columns, or a table's indexes, which until now were
  written to a field that nothing displayed at all. Failures on the same
  connection fold into one notification with a count, so expanding a database
  with forty tables against a server that has gone away is one card, not forty.

  MongoDB error messages are also readable again. They used to arrive with the
  driver's internal bookkeeping appended — and for any command error, a
  hex dump of the server's entire reply — in a message meant to be read in a
  narrow tree row.

- **"Index all databases" could skip half a server and report success.** A
  database whose table list failed was counted as loaded, and every failure that
  was not a connection-limit refusal was reduced to a number with the reason
  discarded. Both the connections tree and the command palette now say how many
  would not answer, and why.

- **The tree's filter could hide the failure it had just been told about.** A
  connection whose schema could not be read looks exactly like an empty one, so
  filtering the tree dimmed its row, gave it a `0`, and folded it to a single
  line — which removed the error message from the screen. The row now shows a
  `!`, carries the message on hover, and is never dimmed or folded: a
  connection the server would not answer is the row you most need to see. A
  multi-database server whose individual databases would not answer says so
  too, instead of counting them as zero.

- **Every context-menu action on a collapsed database node failed silently.**
  "New query here", "New table", "Security", export, import, "New collection"
  and "Refresh" all have to open the database first, and when that failed the
  error was written into a part of the tree that is only drawn when the node is
  expanded: the menu item did nothing and said nothing. A refused `DROP
  DATABASE` did the same, while its success has been reporting since 1.21.3.

- **With pool sharing on, a connection the MCP connector opened was never closed
  by anything.** Turning on Settings → Connections → "Share pools with the MCP
  connector" makes the desktop app open the connection a tool call needs, which
  is the point — one budget per server for the whole machine. What it also did
  was hand that connection the lifecycle of one you had opened yourself: five of
  a server's ten-slot default budget reserved, a keepalive heartbeat pinning one
  physical socket open past the idle timeout indefinitely, and permanent
  residence in the app's pool map.

  Nothing in the product could release it. The reaper never closes a top-level
  pool, on the stated grounds that it is a connection the user opened
  explicitly and the UI shows as connected — and neither half is true here: no
  window lists a connector-opened connection, because a window only shows what
  it opened itself. "Release idle pools" skipped it for the same reason.
  Restarting the app was the only way. Meanwhile, with pool sharing *off*, the
  connector opens its own pool and closes it after five minutes idle. The same
  connection, from the same tool call, was disposable in one mode and immortal
  in the other, which is why idle connections seemed to sometimes come back and
  sometimes not.

  A connection the connector asks for is now marked as such, and treated as
  what it is: it reserves the smaller, database-view-sized share of the server
  rather than a full connection's, gets no heartbeat, and is closed once it has
  been idle for **Close idle connector connections after** — five minutes by
  default, the same as the connector applies to its own, so the behaviour no
  longer depends on which process happens to hold the pool. The connector
  reopens it transparently on its next call. "Release idle pools" now closes
  them too, leaving only the connections you opened.

  If you later connect to one of those connections yourself, the app **adopts**
  it: it becomes an ordinary connection of yours, heartbeat and all, and stops
  being closed automatically. And because these were invisible in the product
  by construction, Settings → Connections now shows how many of the app's
  connections the connector opened, next to the bridge toggle.

- **An unreachable server was reported as "too many connections", thirty seconds
  late, with the wrong remedy attached.** A MySQL profile pointed at a closed
  port, a host behind a firewall that drops SYNs, or an SSH forward that had
  died produced `too many connections: HuginnDB's own connection pool timed out
  waiting for a free slot — HuginnDB is currently holding 0 connection pool(s)
  and 0 per-database pool(s)`. Every clause of that was wrong for the actual
  failure, and the app acted on it: the frontend matches the connection-limit
  marker by substring, so it offered "release idle pools and retry" for a server
  that was not full, and tripped the schema explorer's cross-database circuit
  breaker on a diagnosis that had nothing to do with capacity.

  The cause is in `sqlx`, not in the classification. `PoolOptions::connect` is
  eager, and its retry loop treats a refused connect and a *transient* database
  error as reasons to back off and try again until `acquire_timeout` — thirty
  seconds — and then reports `PoolTimedOut` with the real error discarded. So
  the pool could never say why it failed, and `PoolTimedOut` carried two
  unrelated meanings: "your own pool is starved", which is right for a pool that
  already exists, and "I never reached the host", which is not. Postgres made it
  worse in the other direction: `53300` (`too_many_connections`) counts as
  transient, so a genuinely full Postgres was also retried for thirty seconds
  and then blamed on our pool rather than reported in the server's own words.

  Opening a pool now proves the endpoint first, with a single un-pooled
  connection that has no retry loop, and builds the pool lazily behind it. A
  refused connect fails immediately and says so; a wrong password stays a wrong
  password; a real limit refusal — MySQL `1040`, Postgres `53300` — still
  reports as a limit refusal, carrying the server's own message; and only a host
  that silently drops packets reaches the timeout, where it is reported as one,
  in the same words SQL Server has always used for it. Because the pool is now
  lazy, the open path cannot produce `PoolTimedOut` at all, which is what makes
  the two meanings stay separated rather than being guessed at.

  Also: the error no longer appends "HuginnDB is currently holding 0 connection
  pool(s) and 0 per-database pool(s)". That sentence exists to disclose our own
  share of a server's limit, and it was reported as zero exactly when it was
  least useful — the pool that just failed is never counted, so the first
  connect of a session always said zero, which is what made the misdiagnosis
  convincing. The note about the machine's other clients stays, because it still
  explains a server we did not fill.

- **`describe_table` could not describe a MongoDB view — the one relation whose
  description is the only way to read it.** A view's stored pipeline *is* its
  definition, and `describe_relation_inner` reads it: structure first, then the
  view body. Both halves were strict, so on a view the first half decided
  whether the second ever ran — and on a view it always failed. `listIndexes`
  answers `CommandNotSupportedOnView` (code 166) for every view, because a view
  has no indexes of its own; and before even that, `$sample` cannot take its
  fast path on a view — the server rewrites the aggregation to run the view's
  pipeline first, so our stage is no longer the first one and never gets the
  random cursor. On a view over millions of documents it degrades to reading
  everything the view produces, so field inference timed out. Either way the
  caller got an error and never the pipeline, which had not been read yet.

  Both failures were already understood in this file — for time-series
  collections, which are themselves views over their backing buckets — and the
  catalog lookup that avoids them existed. It just only asked about
  time-series. It now classifies the relation once (`RelationKind`) and both
  halves use the answer: a view skips `listIndexes` rather than failing on it,
  infers its fields from a bounded page instead of `$sample`, and reports no
  fields rather than no description when even that does not finish in time.
  Sampling an ordinary collection stays strict — a failure there is a real one.

  Reported by `describe_table` on a production view; found by reading the
  driver's error instead of the tool's promise.

## [1.21.4] — 2026-09-07

### Added

- **The app says what it did when the result is somewhere you cannot see.**
  Connecting (the one gesture that reliably takes seconds, and the one people
  start before looking away), "disconnect all" and its count, applying a
  structure or view change, dropping or renaming a table, view or database,
  creating, rebuilding, dropping or hiding a MongoDB index, publishing to a
  shared origin, an import's result — which used to vanish with the dialog
  that reported it — an MCP write policy, and copying several rows to the
  clipboard, where the count is the whole question. All pills: one line, gone
  in six seconds, and kept in the bell.

  Deliberately *not* everything. A single disconnect greys its own row and
  closes its own tabs; a reset of the shortcuts or the panel layout is a list
  or a screen visibly reverting; duplicating a theme adds it to the list in
  front of you. Confirming those is the noise that stops people reading the
  ones that matter (CONTRIBUTING → "Feedback and transition state": confirm a
  write only when its effect is not self-evident).

- **A one-line notification anatomy, and a rule that decides when it is not
  enough.** A confirmation used to be a 380px card with a rail, a 28px
  medallion, a body slot and a button row — to deliver the words "Cell saved".
  Every notification that is not an error is now a **pill**: 32px, one line,
  icon plus title plus an optional faint monospaced tail, dismissed by clicking
  it. Errors and file notifications look exactly as they did, because both
  always carry something to act on: a driver message worth copying, a file name
  that opens the folder.

  The interesting half is the boundary. "Non-errors are pills" is only safe if
  something notices when a pill is the wrong shape, so `surfaceFor` in
  `lib/notify.tsx` asks *does this fit on one line* rather than *what kind is
  this*: anything carrying buttons, a file path, or a description too long for
  the line escalates to the card and keeps everything it had. It is decided
  once, at the same seam that already owns duration, grouping and history —
  never at a call site, because a call site that had to remember would be one
  that silently dropped its own buttons.

- **The two anatomies stack in two corners, and Settings → Notifications now has
  a position picker for each.** Pills default to bottom-centre and cards stay
  bottom-right, so a confirmation no longer queues behind an error nobody has
  read. Choosing the *same* corner for both is not a collision to arbitrate — it
  is how they collapse back into a single stack, which is one code path, not a
  special case. Both rows are addressable from the command palette.

### Changed

- **A pill lives for the base duration, where the card it replaced lived for a
  multiple of it.** The multiplier buys reading time and a pill has nothing to
  read; a warning that genuinely carries something to act on has already become
  a card by then, and gets its ×2 back with it. A pill also has no draining
  hairline: a straight 2px bar clipped by a 999px radius reads as a lens, and a
  ring around a 14px icon would mean "time left" on a confirmation and "work
  done" on a progress bar — one shape, two meanings. The known cost is that
  "expand on hover" no longer has a visible acknowledgement on a pill.

- **A long-running task that fails now moves instead of resolving in place.** A
  `progress` notification normally turns into its own outcome without leaving
  its slot; a progress *pill* that fails into an error *card* belongs to a
  different stack, so it is withdrawn and the error raised fresh. The
  same-slot promise is kept everywhere it still can be — `progress → success`
  never moves.

### Fixed

- **A connection dropping by itself now says so, with a Reconnect button.** The
  three-minute heartbeat has flagged lost connections since 1.4.0, but only as
  a badge on a row in a panel that may not be open — so the first thing anyone
  actually learned was a cryptic driver error in the middle of the next query.
  Carrying an action escalates it out of a pill and into a card, which is
  right: a dead pool is not something to glance at. One card per connection
  however many times the heartbeat re-reports it, and only on the transition
  into "lost".

- **A session restore that cannot reopen a connection stops doing it in
  silence.** Entering an environment reopens everything it had; a failure was a
  `console.warn`, and the tab was restored anyway — so the user got a table
  view backed by nothing and found out when a query came back with a driver
  error. One warning for the whole batch, not one per connection: a server that
  is down takes all of its connections with it.

- **A shared origin that changes your connections while you are working now
  says how many.** `syncAll` runs on a poll and at startup and can add or
  update profiles and whole environments; silence there is how a colleague's
  edit shows up as "my connections moved on their own". Only when something
  actually changed — a "nothing happened" card every few minutes is exactly the
  noise that stops people reading.

- **Three copies of "connect this profile" became one.** The connections tree
  used the shared `connectAndWarm`; the status bar and the command palette each
  carried their own inlined version, and they had already drifted — one gave the
  wrong-driver hint on a failure and the other did not. The command palette's
  *disconnect* was a bare store call, dropping the pool without dropping the
  cached schema or the tabs pointing at it, which is the same gap "disconnect
  all" was fixed for in 1.20.0.

- **A refused write to the database used to leave no trace at all.** Committing
  a cell edit from the inline editor, the foreign-key picker, Ctrl+V or "Set
  NULL" ended in `.catch(() => {})` — five of them, across three files. The
  server rejected the `UPDATE`, the confirmation flash simply did not happen,
  and silence had to be read as failure by a user who had just been taught to
  read silence as success. The report goes at the same seam in `DataGrid` that
  already owns the flash, so every existing commit path and any added later is
  covered without knowing the rule exists; the modal editor and the docked side
  panel opt out, because both keep the editor open and print the driver message
  beside the value that caused it.

- **The whole environments CRUD failed in silence.** Creating, renaming,
  deleting, reordering and re-skinning an environment each ended in
  `set({ error })` against a field no component has ever rendered. They now go
  through one `fail` helper that records *and* reports. Deleting also stopped
  lying about what happened: the confirm dialog closed even when the delete was
  refused — the environment was still there and the dialog said it was gone —
  so `remove` returns whether it worked and the dialog stays open when it did
  not.

- **Six handlers in Settings → Origins had a `try`/`finally` with no `catch`.**
  Registering an origin, editing one, creating an origin document, removing one,
  and adopting or retiring vanished profiles all left an unhandled rejection and
  a dialog that had simply stopped responding. Every one of them is a write
  whose effect is somewhere else entirely, so there was nothing on screen to
  read the outcome off either.

- **Other places a failure went to the console and nowhere else**: the
  connection list failing to load (which looked like a fresh install), a
  preferences file that could not be written (settings that silently would not
  survive the next launch) or read (defaults, presented as if nothing had
  happened), "New window" from the Window menu — the only one of its three
  entry points that stayed quiet — a JSON Schema binding toggled or deleted
  against a store that refused the write, and a privileges query whose failure
  was rendered as the reassuring, and wrong, answer that the user has none.


- **The three window roots no longer each carry their own copy of the
  notification container.** `App`, the detached-tab window and the Pulse window
  had an identical `<Toaster>` invocation, with the edge offset written out a
  fourth time inside the overflow badge — four places to keep in sync for one
  decision, and the reason `lib/notify`'s opening claim that "nothing outside
  this module imports `sonner`" had quietly stopped being true. One
  `<NotificationHosts>` now owns every host, and the claim is true again.

## [1.21.3] — 2026-09-07

### Added

- **A "Direct connection" toggle in the MongoDB connection form** (new and edit
  alike), which adds `directConnection=true` to the derived URI. It is what you
  need when you are reaching one member of a replica set on purpose — through a
  jump box, or to read from a specific secondary: without it the driver treats
  the host you typed as a seed, reads the set's real member addresses out of its
  `hello` response, and tries to reach *those* instead, so a connection to a
  perfectly reachable host fails because the names it advertises are internal
  ones this machine cannot resolve. Until now the only way to set it was the
  "Edit connection string" escape hatch, which had a sting in the tail: the
  form's parser rejected any URI option it did not model, so a profile saved
  that way reopened in raw-edit mode forever after, with host, port and database
  greyed out.

  Modelled as a query option on the derived URI rather than as a new profile
  field, which is why nothing in the backend changed: the driver reads
  `directConnection` straight off the connection string, and a MongoDB profile
  always stores its URI. It exports, imports and syncs through a shared origin
  for free as a result — and it is deliberately *not* added to the fields a
  shared-origin refresh preserves locally, because unlike the MCP and Pulse
  toggles it is a fact about the server's topology, not a decision belonging to
  this machine. The publisher dictates it, the same as host and port.

### Fixed

- **The schema tree and the tab area are no longer live while an environment
  switch is tearing the session down.** Switching environments is not a pointer
  move: `switchTo` flushes the outgoing tab state, empties `useTabs`, clears the
  selected connection, then closes every live pool **one at a time** — each a
  round trip, and one *per database* through an SSH tunnel or a pooler — before
  reconnecting the incoming set and replaying the saved layout. For that whole
  window, which is seconds rather than frames on a real workload, the connections
  tree stayed fully interactive on top of a deliberately half-torn-down store: a
  click could open a pool belonging to the environment being *left* while its
  siblings were being dropped, or aim a `list_tables` at a pool mid-teardown and
  leave a stale "not connected" error over a connection that ends up perfectly
  healthy. The store already modelled the transition correctly (`switchingTo`
  names the environment being entered, not a boolean — see gotcha #61), but only
  the three environment *pickers* consumed it; nothing in the tree or the centre
  column knew a switch was happening at all. Both are now sealed off by a single
  `EnvironmentSwitchGuard` seam, which curtains them with a real pointer target
  and marks the content `inert` so the keyboard cannot walk past it either — the
  tree carries its own key handling and a `data-kb-scope`, so a veil alone would
  not have stopped an already-focused row. The environment rail deliberately
  stays outside the guard: it already models the same transition and is the one
  surface that must stay legible while the swap runs.

- **"New environment → start from X" is now covered by the same guard.** That
  route enters the new environment twice: a cheap `switchTo` into something still
  empty, and then — after the replicated launch state is written — a second
  `restoreSession` that actually opens the copied connections. `switchTo` had
  already cleared `switchingTo` by then, so the slower of the two passes was the
  one running unguarded. `createAndEnter` now holds the flag across its whole
  seeding pass and clears it in a `finally`, so a failure there cannot leave the
  UI curtained.

  The launch restore is deliberately *not* guarded: it closes no pool and empties
  no tab store, so the hazard does not exist there, and curtaining the tree for
  the whole of a launch reconnect would trade a real bug for a worse first
  impression.

- **Copying now reaches the system clipboard, and pasting no longer asks
  permission.** Both halves of the clipboard went through the webview's own
  Clipboard API, which was wrong in two separate ways. Ctrl+V called
  `navigator.clipboard.readText()`, and WebView2 answers that with its own
  "allow this site to see text and images copied to the clipboard" dialog —
  correct in a browser tab, absurd in an installed desktop app on a paste the
  user just asked for, and impossible to style, reword or pre-grant from the app
  because it belongs to the engine, not to HuginnDB. Meanwhile every copy path
  called `writeText()`, which lands in the webview's own channel: pasting back
  *into* HuginnDB worked, which is what made this look healthy, but the value
  was never in the system clipboard — copy anything else in any other app and
  the cell you copied was simply gone, and it never appeared in the OS clipboard
  history either. Both now go through Tauri's clipboard plugin, so the read
  happens in Rust (no webview permission model to ask) and the write goes to the
  OS clipboard where the rest of the desktop looks for it.

  Along the way, `navigator.clipboard` stopped being scattered: the helper
  existed but six call sites bypassed it entirely — the schema tree's "Copy
  name" and "Copy SELECT", the pipeline output and its export dialog, the MCP
  settings copy button, the status bar's history fallback and the connection
  dialog's error copier — each with its own (absent) error handling. All seven
  now share one seam, which also moved out of `lib/grid/` since the notification
  system had been importing it for a while. Three "Copied" confirmations that
  used to fire without waiting for the write now follow it, because a failure is
  finally something that can be observed.

  Two limits worth stating: on Linux the clipboard belongs to the process that
  set it, so a value copied from HuginnDB still disappears when HuginnDB exits
  (a platform property; Windows is unaffected), and Ctrl+C/Ctrl+V still do not
  reach the MongoDB document list view, which predates this change.

## [1.21.2] — 2026-09-04

### Fixed

- **The structure and view editors no longer crash the whole app on a
  Windows release build.** Opening a table's structure or a view — on any
  driver, any table — reliably killed the process right as the "loading"
  screen finished, with nothing to show for it but
  `thread 'main' has overflowed its stack` on stderr, invisible in a normal
  install because release links the app as a `windows`-subsystem binary
  (no console). It never reproduced in `pnpm tauri:dev`, which made it look
  frontend-related; bisecting confirmed otherwise — an unoptimized `--debug`
  build of the *same* production frontend bundle didn't crash either, only a
  real `tauri:build` release did. The actual variable was Rust's optimizer:
  MSVC's linker reserves a 1 MiB main-thread stack by default (8 MiB on
  Linux/macOS), and release's inlining collapses the structure/view
  introspection call chain (`ensure_view` → `pool_for` → the
  `information_schema` catalog queries) into fewer, larger stack frames than
  the same chain needs unoptimized — comfortably under 1 MiB in dev, just
  over it once optimized. Fixed by reserving 8 MiB for the main thread via
  `/STACK` at link time (`src-tauri/.cargo/config.toml`, Windows only)
  instead of restructuring the call chain to fit an arbitrarily small
  budget.

- **Pulse's storage totals no longer double-count free space on MongoDB.**
  `StorageItem::total()` summed `data_bytes + index_bytes + free_bytes`
  unconditionally, which is right for MySQL — `Data_free` sits outside
  `Data_length` — but wrong for MongoDB, where `freeStorageSize` is WiredTiger's
  *reclaimable portion of* `storageSize`, already inside `data_bytes`. Every
  MongoDB collection's reported total was therefore inflated by its own free
  space, which also skewed the top-N ranking (`sort_unstable_by_key` on that
  same total) — a fragmented collection could outrank a genuinely larger one
  and get pushed out of the list.

  `StorageItem` now carries `free_is_within_data` (set per driver at
  construction — `false` for MySQL, `true` for MongoDB) and a backend-computed
  `total_bytes` that reads it, so the frontend no longer re-derives the sum
  itself — the two Pulse surfaces (`PulsePanel`, `PulseWindow`) and
  `usePulseView`'s grand total were each duplicating the same formula, which is
  exactly what let it drift for MongoDB in the first place. The segmented
  storage bar now reflects the corrected semantics too: on MongoDB, the free
  portion renders as a hatched overlay at the trailing edge of the data
  segment (it's *inside* it) instead of a third segment that used to add its
  own width on top of an already-too-large total.

## [1.21.1] — 2026-09-03

### Added

- **The aggregation editor's inline autocomplete now inserts a stage's whole
  structure, not just its name.** Picking `$group` from the header `Select`
  already replaced the body with the full snippet (`_id`, an accumulator);
  typing `$group` in the editor and accepting the completion only inserted
  `$group: `, leaving the rest to be typed by hand — the gap this closes.
  Every stage in the catalogue now has a Monaco snippet (tabstop syntax,
  `InsertAsSnippet`) alongside its plain one, so Tab walks `_id`, the
  accumulator, the field name — the same interaction Compass's stage
  autocomplete has.

  **A `$group`/`$bucket`/`$bucketAuto`/`$setWindowFields` accumulator
  (`$sum`, `$avg`, `$push`, …) gets the same treatment, and needed its own
  catalogue to get it right.** An accumulator is never valid bare — only
  `{ $sum: 1 }` is legal, not `$sum: 1` on its own — so it couldn't share the
  flat expression-operator list the way `$concat`/`$cond` do; it's offered
  only while the cursor is defining an output field's value inside one of
  those four stages (never for `$group`'s own `_id`, which is an expression,
  not a reduction), and inserts the whole wrapped object.

  One more fix riding along: typing `$` anywhere used to dump all 28 stage
  names into the list regardless of position — inside a nested `$match`
  filter, say. Stage suggestions are now offered only at a stage body's own
  top-level key, or at the root of a nested sub-pipeline's stage doc
  (`$lookup.pipeline`, a `$facet` branch, `$unionWith.pipeline`).

  Hand-escaping `$` across 28 snippets (`\$` where it's a literal character,
  never a tabstop — Monaco's snippet grammar reads a bare `$name` as an
  unresolved TextMate variable and silently drops it) is exactly the kind of
  change a typo hides in; `stages.test.ts` strips every snippet's tabstop
  syntax back down to plain text and asserts it reproduces the existing
  plain snippet byte for byte.

  Four more gaps turned up dogfooding it against a real `$group`:

  - The accumulator branch above only recognised the *bare* slot
    (`count: $su`, no braces yet) — but tabbing into the very snippet this
    entry describes lands the cursor *inside* an already-open `{ }` (the
    accumulator tabstop it seeded), one frame deeper. That's a second,
    equally valid slot the first cut never covered, so the widget fell back
    to whatever unrelated expression operator shared the typed prefix.
  - An expression operator (`$concat`, `$cond`, …) is always an object
    *key* — it's never legal as a bare value — but the completion list
    offered the whole ~50-entry set at *any* `$`-prefixed position,
    including a plain field reference like `$group`'s own `_id: "$field"`.
    That buried the one suggestion actually useful there (a real collection
    field name) under operator noise; the list is now offered only where
    the cursor is choosing a key.
  - Editing that same `_id` value by hand never reopened the suggestion
    popup at all: Monaco's `quickSuggestions` leaves `strings` off by
    default, so the widget only opens on the initial `"`/`$` trigger
    character, never again while typing plain letters afterward — exactly
    what overwriting a snippet's own placeholder does.
  - And once all three of those were fixed, the field-name suggestions
    *still* silently failed to appear: Monaco filters every completion item
    by comparing its own **label** against whatever text the replaced range
    currently spans, and a `"$"`-prefixed value replaces a range that
    includes the `$` the user already typed — but the field items' label
    was the bare name (`"entity"`), never matching `"$en"`. The item's
    `insertText` was already correct (`"$entity"`); only the label,
    compared for filtering, was wrong. It now carries the same prefix as
    what's actually being replaced.

  A single-stage pipeline that fails also used to show the exact same
  error twice — once in the failing stage's own card, once more in a
  tab-level summary below the stage list, since a one-stage pipeline's
  only stage is also its *last* one. That summary exists for when the
  per-stage output column is hidden and no card shows anything at all; it
  just wasn't gated on that, so it fired even when the card right above it
  already said the same thing.

- **A colored ribbon in each window's chrome once more than one is open, naming which window it is.** "New window", a detached tab and the Pulse window all used to look identical from the outside — same title, same everything — so with a few open at once there was no way to tell "this is my main session" from "this is the duplicate I opened by accident" short of closing them one by one. Every window now derives a hue from its own Tauri label and shows a ribbon carrying an accent dot in that color, the window's kind ("Main window" / "New window" / "Floating tab" / "Pulse panel"), and how many windows are open in total. The ribbon disappears the moment only one window remains — the whole problem is telling windows apart, which stops being a problem with nothing to confuse it with.

  The main window's label is the fixed string `"main"`, so it always gets the same hue session after session; every other window gets a fresh UUID at creation, so duplicates land on their own color in practice with nothing stored to keep in sync. The window count itself comes straight from Tauri's own window registry (`getAllWindows()`), kept fresh across windows via a new `huginndb://window-list-changed` broadcast emitted on both window creation and destruction — a genuine broadcast, not `emit_to` a single window, since every window's ribbon needs the total count, not just changes it caused itself.

- **"Open in new window" on a connection's context menu.** Right-click a
  connection in the tree and it opens in its own window, already connected —
  the gesture the CLI could already express (`--connect-profile` into a second
  launch) with no way to reach it from the UI. Offered whether or not the
  connection is currently active; the disconnected case is the primary one
  ("open this server in its own window without disturbing the one I have"),
  and until now that branch of the menu offered only "Connect".

  **No second pool is opened.** `AppState` is per process and shared across
  windows, and `connect_inner`'s early return already handles a second window
  connecting to a profile the first has open — so there is no second endpoint
  reservation and no second SSH tunnel. Each window still lists as active only
  what it opened itself, which is deliberate (issue #50).

  Two inherited behaviours worth knowing, neither new: disconnecting in any
  window closes the pool for all of them, and closing a secondary window
  leaves a pool it alone opened alive until the app exits. The CLI path has
  always behaved this way.

  If the profile has no password in the keychain — an `ephemeral` CLI launch,
  or a password typed into the dialog only this session — the new window opens
  and fails to connect, with the error in its Console panel. The entry is
  deliberately not gated on having a stored secret: the failure is legible,
  and gating would hide the majority case to spare the minority one.

- **Disk size per database in the schema tree (#153).** The issue asked for a
  way to see how much space a database and its tables take. Half of that was
  already built and switched off: `TableInfo.size_bytes` has been populated by
  all five drivers for a long time and the tree already renders it, but
  `ui.schemaTableMetric` shipped defaulting to `"none"`. What was genuinely
  missing is the database level — `DatabaseInfo` was literally `{ name }`.

  A new deferred `get_database_sizes` command answers it for all five drivers,
  and the badge appears on the database node (and, on SQLite, on the schema
  node, which is the only node that driver has). It is **not** folded into
  `list_databases`: on Postgres this is `pg_database_size`, which is not a
  catalog read but a walk of the database's directory calling `stat` per file
  — seconds on a server with nineteen large databases, on the path that
  expands a connection, under a 20 s timeout. It is fetched when a database
  node renders, once, and cleared by "Refresh" along with the rest of the
  schema.

  **The five numbers do not agree with each other, and cannot.** Postgres
  counts the whole directory, free space included; MySQL sums
  `DATA_LENGTH + INDEX_LENGTH` and cannot see free space at all; SQLite
  multiplies out the page count, freelist in, `-wal` out; MongoDB reports
  `sizeOnDisk`, which is *compressed*; SQL Server sums the allocated data
  files and excludes the log. They will not match the sum of the per-table
  badges either. Each driver's source is documented where it is queried.

  **An engine that will not answer produces no badge — never a `0`.** The case
  this is built around is real: a MariaDB 11.4 with a low-privilege login
  returns `NULL` for the aggregate on a schema with 31 tables, and rendering
  that as zero would say the data is gone.

- **The schema-tree metric can show both numbers at once.** `ui.schemaTableMetric`
  gains `"both"`, rendering `12.1k · 4.3 MB`. The app has had both figures for
  every driver since the metric existed and made you pick one.

- **The structure editor shows the table's size and row count.** A chip beside
  the table name in edit mode, read from the `TableInfo` the tree already
  holds — no additional query.

- **`IN` / `NOT IN` can be built by hand, and a filter chip is editable.**
  The two operators already worked end to end — the backend deduplicates the
  list, lifts a `null` member into its own `IS NULL` branch, and caps it at
  1000 values — but the only way to get one was the grid's "filter by the
  selected rows" action. The advanced filter withheld them from its operator
  list and set any it was handed aside, untouched, because its condition row
  had no control for a value list. It has one now: a one-value-per-line
  textarea with a separate **Include NULL** checkbox.

  The checkbox is the part worth explaining. `NULL` as a magic *token* in the
  list would be indistinguishable from the literal four-character string
  `"NULL"`, which is a legal value in a text column and one you would then have
  no way to search for. Splitting them mirrors what the backend already does.
  The textarea splits on `\r?\n`, so a column pasted from Excel does not
  arrive with an invisible carriage return glued to every value.

  Because every filter shape now has a control, the dialog edits the whole
  filter list in order rather than a subset of it — which is what makes a
  toolbar chip's position a row index, and that is the entire mechanism behind
  the second half: **clicking a chip opens the advanced filter scrolled to
  that condition.** No ids, no new DTO, no backend change.

- **Every operator is offered on every column.** A numeric or date column used
  to lose `contains`/`starts with`/`ends with` and a text column lost the
  ordered comparisons, while the backend restricted neither. "The invoice
  number contains 4471" is a thing people ask for, and the SQL builder already
  casts the column to text to answer it.

### Changed

- **`ui.schemaTableMetric` now defaults to `"size"` instead of `"none"`.**
  This is the one change in this release that alters what somebody sees
  without their asking, so it is worth being straight about the trade: a
  number beside every table is visual noise, and `"row-count"` is arguably
  more useful day to day. What settles it is that `"none"` was never saving
  anything — every driver fills `size_bytes` whatever the preference says, and
  on SQLite that is N `dbstat` queries the backend runs because it cannot see
  the preference at all. So the old default paid the cost and hid the result.

  Only fresh installs move. `save_preferences` writes the whole struct, so
  anyone who has ever touched a single preference already has an explicit
  value on disk.

### Fixed

- **A text match against a non-string MongoDB field silently matched nothing.**
  BSON's `$regex` inspects strings only, so `contains` on a `long`, a date or
  an `ObjectId` returned zero rows — not an error, just an empty result set
  that reads as "there is nothing here".
  `db.entityLog.countDocuments({ts: {$regex: "1788"}})` answers 0 on a
  collection where every `ts` begins with those digits and
  `{ts: {$gte: 1788422462450}}` answers 6. The SQL drivers never had the blind
  spot, because their builder wraps the column in `CAST(col AS TEXT)` first.

  `contains` / `not contains` / `starts with` / `ends with` now emit two
  branches: the plain `$regex`, which still uses an index on a string field —
  the common case, and the reason it is not simply replaced — and an `$expr`
  that stringifies the field server-side to cover everything else.
  **The `$expr` branch cannot use an index**, so a text match over a large
  collection degrades to a scan; that is the cost of the operator answering
  truthfully instead of returning nothing, and it is why the fix landed before
  those operators were offered on numeric columns rather than after. Requires
  MongoDB 4.2 (for `$regexMatch`), one minor above the driver's own floor.

- **"Bulk update" silently widened its own match.** Opening it with an
  `IN (…)` chip active dropped that filter while seeding the match condition,
  turning an update scoped to forty rows into one scoped to the whole table.
  The "no filter" acknowledgement could not catch it either, since the other
  filters remained and the list was therefore not empty. It seeds every filter
  shape now.

- **The 1000-value `IN` cap was not enforced on the update path.**
  `validate_filters` was private to the browse path, so `apply_bulk_update` —
  which shares the very same filter builder — accepted an unbounded list, in
  an `UPDATE`'s `WHERE` rather than a paginated `SELECT`'s. The advanced
  filter also now blocks Apply with a count in red rather than truncating the
  list or letting the call fail after the fact.

- **Opening the advanced filter no longer degrades the filters it holds.** A
  condition row can only carry a value as text, so pressing Apply used to
  rewrite a MongoDB `Int64`, a JSON object or a value containing a newline as
  whatever `String(value)` produced. A row the user did not touch now returns
  its original payload untouched. Editing such a value still re-types it from
  the column's catalog type, which is documented where the coercion lives.

- **`formatBytes` stopped at GB, so a 5 TB database would have rendered as
  "5120.0 GB".** It now runs through PB. Its loop also used `n > 1024`, which
  printed exactly 1024 bytes as "1024.0 B". Neither could bite while the
  helper only ever labelled one table; both are reachable with database-level
  sizes.

## [1.21.0] — 2026-09-02

### Added

- **The grid confirms that a write landed.** Committing a cell edit ran the
  `UPDATE`, refetched, and left the cell looking exactly as it did while you
  were typing — the only signal of failure was a toast, so silence had to be
  read as success. A single 520 ms pulse now marks the cell, or in the list view
  the field, once the save has resolved and the page has been refetched, so it
  confirms the *stored* value rather than the keystrokes.

  Two notes on how rather than what. The token was already there and unused:
  `brand-flash` is the "short blue pulse on a completed action" the visual brief
  asked for, and until now the settings screen's scroll-to-preference highlight
  was its only consumer in the app. And the confirmation is decided once, by
  wrapping the two save callbacks in `DataGrid` before they are handed down —
  there are twelve places a save is fired from across six files, and decorating
  each would have been twelve chances to forget, which is how the app came to
  have no confirmation at all.

- **Write a MongoDB document by hand instead of picking a file.** Adding one
  record to a collection meant opening a file picker: "Import JSON" was the
  only path that could produce an arbitrary document, and it exists for bulk
  loads. The inline draft row could not stand in for it either — it iterates
  the columns the grid discovered, and on a schemaless store those are sampled
  from one page of documents, so a field that page did not contain could not be
  typed at all. Both paths stay; the draft row is faster whenever the shape is
  already right.

  The text is parsed in Rust by `shell::parse_relaxed_value`, the same parser
  behind the query editor and the aggregation builder, so a document pasted out
  of a shell session means here what it means everywhere else — `ObjectId(…)`,
  `ISODate(…)`, `NumberLong(…)`, unquoted keys, comments. A `JSON.parse` would
  reject most of that and would silently narrow a `NumberLong` that fits in an
  `Int32`, which is invisible in testing and permanent in the data. An array is
  accepted and inserted with `insert_many`, so pasting the output of a `find()`
  works.

- **Fit every column into the visible width.** The grid could size a column to
  its content; it could not make a whole row readable without scrolling
  sideways. Added as a second control rather than a mode on the first, because
  the two answer different questions and both are right — one is for reading a
  long value, the other for scanning rows. It starts from the content fit
  rather than dividing the width evenly, so an `id` column stays narrow and a
  `description` stays wide. Shrinking is water-filling: a flat scale drives
  narrow columns under the floor, and clamping them afterwards overshoots the
  target, leaving the scrollbar the gesture was meant to remove.

### Fixed

- **The environment switch spinner sat on the environment you were leaving.**
  `switchTo` flushes the outgoing session and closes every one of its pools
  before `activeId` moves, so a `switching` boolean paired with "is this the
  active one?" pointed at the wrong row for the whole of the slow part. The
  store now tracks the *target* (`switchingTo`), which is what a boolean could
  not express. `WorkspacePicker` had already worked around it with a local copy
  of exactly this state; that copy is gone.

- **A tooltip lingered over its neighbour.** Radix's `disableHoverableContent`
  defaults to off, which keeps a tooltip open while the pointer crosses a grace
  area toward the content. Nothing in the app has hoverable tooltip content, so
  that bought nothing and cost this: moving between two adjacent icon buttons
  left the first tooltip up while the second opened with no delay. Set on the
  app's own `TooltipProvider` rather than at each of the three window roots, so
  a fourth root cannot be added without it.

- **"Disconnect all" did not read as destructive.** It drops every live pool in
  the tree and looked exactly like the filter button beside it. It is an
  `IconButton` with `tone="destructive"` now — an affordance that shipped with
  the primitive layer and that this call site had never adopted.

- **The inline cell editor's expand button had a visible seam.** Its buttons
  were flex siblings of a bordered input, each painting an opaque background so
  `sticky` had something to sit on — a hard-edged pale rectangle against a
  rounded, focus-haloed field, worst in exactly the state you edit in. The
  affordances now live inside the field's box, sharing its surface, which is
  what `SearchField` and `TreeFilterBox` already did. They also travel together
  in one sticky group: only the expand button was pinned before, so on a wide
  column "∅" scrolled away while its neighbour stayed.

- **The component library's adoption gap is now a ratchet in CI
  (`src/components/ui/uiAdoption.test.ts`).** The primitive layer landed with a
  contract test, tokens and a motion band, and then only half the app adopted
  it: 140 raw `<button>` elements and 81 native `title=` attributes still sit
  outside `ui/`, each one re-deciding a hover alpha, a focus ring or a tooltip
  delay that a primitive already answers. Two of them are visible bugs —
  `ConnectionsTree`'s "disconnect all" reads like a neutral action because it is
  a hand-rolled button rather than an `IconButton` with the `tone="destructive"`
  that already exists, and `GridToolbar`'s insert button shows the OS tooltip
  from a `<Button size="sm" title=…>`, which `uiContracts.test.ts`'s rule H
  misses because that rule only fires on `size="icon"`.

  The guard is a per-file budget seeded with today's real count and asserted
  exactly, so debt cannot grow *and* a cleanup has to come and lower the number
  — which puts the progress in the diff (`6` → `5`) next to the change that
  earned it, instead of somewhere you have to go and measure. The maps are
  sorted by debt descending, so each doubles as a worklist in priority order.

  It is a **separate file from `uiContracts.test.ts` on purpose.** That file's
  stated admission rule is that every allowlist must be able to end up empty,
  and it explicitly *rejected* banning native `title=` on those grounds. This
  does not reverse that call: a contract says "this is a bug", a budget says
  "this is debt and it may only shrink", and a hundred-plus call sites can only
  be the second. When a budget empties, the rule graduates into
  `uiContracts.test.ts` with an empty allowlist and leaves the ratchet; when
  both have, the file is deleted. Failures assert on the *delta*, not the
  census, because Vitest abbreviates a diff between two seventy-key objects to
  `{ …(72) }` — the output now names the file and the transition.

- **The connector ships as an MCP Bundle (`.mcpb`), so Claude Desktop installs
  it in one click.** Claude Desktop has no CLI, so its setup was the worst of
  the lot: open a JSON config file by hand, paste an absolute path with doubled
  backslashes, restart the app. Every release now attaches
  `huginndb-mcp-<version>-win32.mcpb` (and a `-linux` one) alongside the
  installers; **Settings → Extensions** takes the file and does the rest.

  One bundle per platform, because the payload is a precompiled binary and a
  fat bundle would charge every install for architectures it will never run.
  The bundle carries the sidecar but is deliberately **not** standalone:
  HuginnDB must be installed on the same machine, since that is where the
  connection profiles and their keychain entries live. It declares no
  `user_config` at all — which is only possible because exposure moved into the
  app earlier in this release, so there is nothing left for an extension
  installer to ask.

  `mcpb/manifest.json` is source and `scripts/build-mcpb.sh` assembles the zip.
  Two details in that script are load-bearing rather than incidental: the
  version is read from `package.json` so this is not a fifth place to bump on a
  release (RELEASING.md lists the four that are), and each zip entry's mode is
  set explicitly, because a zip carries its own permissions and the default
  loses the executable bit — the same trap as the release workflow's sidecar
  `cp`, one layer out. A test asserts the manifest's tool list is exactly what
  the router serves, since nothing else links the two files and a bundle that
  lies about its own tools would do so silently.

  Also new: `docs/MCPB_SUBMISSION.md`, the dossier a directory submission asks
  for — server basics, how to stand up a review environment from the Chinook
  sample, example prompts verified against a real MCP handshake rather than
  imagined, and a table mapping each stated requirement to where it is met. It
  lives in the repo so it stays in step with the code instead of being a form
  somebody filled in once.

  Also new: `docs/PRIVACY.md`, the policy an MCPB directory submission requires
  and which the product needed anyway. It is short because there is little to
  say — HuginnDB collects nothing, has no backend, and the only thing the
  connector writes is a local audit log — but the one paragraph worth reading
  is the one about the AI client: query results go to the application that
  asked for them, and what *it* does with them is governed by its policy, not
  ours.

- **Settings → MCP can register the connector with Claude Code in one click.**
  The last manual step in the setup was copying an absolute path out of the
  panel and into a terminal (or, worse, into a JSON file). The new button runs
  exactly the command the panel already displayed —
  `claude mcp add huginndb -s user -- <sidecar>` — and reports back in the
  panel. Clicking it twice is harmless: "already registered" is reported as a
  state, not a failure, because that is simply what a second click looks like.
  If the `claude` CLI isn't on `PATH`, it says so and the copyable command
  stays as the fallback, which is the ordinary case for someone who only uses
  Claude Desktop. Undo with `claude mcp remove huginndb`.

  Implemented without `tauri-plugin-shell`. That plugin exists to let the
  *frontend* spawn processes, which this codebase does not do anyway — all I/O
  lives in Rust commands — so it would have bought a dependency and a
  capability surface and nothing else; `is_mcp_sidecar_running` had already
  made the same call. The one Windows subtlety is why `find_in_path` exists
  rather than a bare `Command::new("claude")`: `CreateProcess` does not apply
  `PATHEXT`, so `claude.cmd` is invisible to it, and resolving the executable
  ourselves also lets the sidecar path travel as a plain argv entry instead of
  being quoted into a `cmd /C` string — it routinely contains spaces.

- **Every MCP tool now carries a title and MCP annotations.** The connector
  shipped twenty-four tools with a description and nothing else, so a client
  had only the name to go on when deciding how much friction a call deserved:
  `list_tables` was treated with the same suspicion as `delete_rows`, and the
  cost of that landed entirely on the seventeen tools that only read. They now
  declare `readOnlyHint`, and the seven writes declare `destructiveHint` /
  `idempotentHint` — with `insert_row` and `create_index` marked *additive*
  rather than destructive, which matters because `destructiveHint` defaults to
  true whenever it is absent. `openWorldHint` is set throughout (false for the
  two that only read local state: `list_connections` and `pulse_metrics`).

  `run_query` was the one tool no constant described honestly, and the fix was
  to stop asking it to: **reading and writing are now two tools.** `run_query`
  runs read-only statements and is annotated `readOnlyHint`; the new
  `run_write` runs the ones that change something and is annotated
  `destructiveHint`. Each refuses the other's traffic and names the tool to use
  instead — refusing *reads* on `run_write` matters as much as the reverse, or a
  model routes everything through the write tool and the split buys nothing.
  Both keep going through the same executor and the same policy gate, which
  still re-reads `mcp_write` from disk per call.

  That split fell out of an idea worth recording as a trap, because it looks
  obviously right: deriving `run_query`'s annotation from the write policies of
  the currently exposed connections. A client reads `tools/list` **once**, at
  startup, while every policy and exposure decision here is re-read per call
  precisely so it can change under a running client — so a snapshot-derived
  hint would go stale in the *unsafe* direction the moment a connection was
  raised to `data`, leaving an auto-approving client convinced no confirmation
  was needed for a write. The gate would still hold; the prompt the user
  thought they had would be gone. Two tools with constant annotations have no
  such failure mode, and they buy something the single tool never could: a
  client's permission rules key on the tool *name*, so "let the SELECTs run,
  ask me about the rest" is now expressible.

  `--read-only` is the one input still allowed to vary the surface, because it
  is a process argument fixed for the life of the sidecar: under it the eight
  write tools are removed from `tools/list` outright rather than left to answer
  with a refusal. `ToolRouter::call` rejects a disabled route too, so it is a
  gate and not a presentation trick.

  Enforced by test rather than by the compiler (`annotations` is optional on
  `Tool`, so an unannotated tool builds fine and simply tells clients nothing):
  one test asserts every tool has a title, a `readOnlyHint` and an
  `openWorldHint`, another that no write tool claims to be read-only and that
  the two additive ones say so out loud, and a third that `--read-only` really
  does take all eight off the surface.

### Changed

- **The dense micro-type is on the scale it was built for.** 286 places wrote
  `text-[10px]`, `text-[11px]` or `text-[9px]` directly, which is what the app's
  `3xs`/`2xs` tokens were added to replace — that migration had only reached
  about a third of the way. Same pixel sizes, but the line-height is now pinned
  rather than inherited, so two labels of the same size sitting side by side
  finally line up. Six chips were below the 10px legibility floor the scale
  exists to enforce and have been raised to it.

- **Sixty-nine corners now follow the theme's radius.** Tailwind's bare
  `rounded` is a fixed 4px that sits outside the app's radius scale, so those
  corners were the only ones in the interface that could never move with the
  theme — they are `rounded-sm` (6px) now, which is the scale's first step.
  Two pixels rounder in those places, and one fewer thing that stops working the
  day the corner radius becomes something you can set.

- **One hover colour instead of five.** A pointer over a row, a menu item or a
  toolbar button used to tint it at any of five strengths — fully opaque in 29
  places, and at 30%, 40%, 50% or 60% in 50 others — so the same gesture read
  differently depending on which panel you were in, and two adjacent surfaces
  could disagree. They all use the theme's hover colour at full strength now.
  The reasoning is worth stating because it is the rule going forward: `--accent`
  *is* the hover surface, so if the result reads too strong the fix is that
  token, not fifty call sites. The command palette's backdrop also matches every
  other modal's now, rather than being 10% lighter.

- **Loading spinners, status pills and section headings are three shared
  primitives instead of three habits.** The spinner appeared in 39 places at
  three sizes; section headings in 24, in four spellings of the same 10px
  uppercase style — including two that disagreed on letter-spacing; and status
  pills were one private component plus about thirty hand-rolled spans. Section
  headings inside menus now use a real menu label, which is what they always
  wanted. Visible where a heading was 11px: it settles at the shared 10px.

- **The native dropdowns are one control, and the theme fix behind them exists
  once.** WebView2 paints a `<select>`'s popup using the trigger's own
  background colour, so a transparent trigger opens an OS-light popup however
  dark the app's theme is. Every one of the eight native selects in the app
  carried its own copy of that fix, in four different spellings of the
  surrounding chrome — a workaround one copy-paste away from being lost. It is
  now unconditional in the primitive. The dense ones grow from 24px to the
  shared 28px along the way.

- **Checkboxes are one control now.** Thirty-five of them were native inputs
  written out per call site, in four sizes, with the mixed ("some selected")
  state hand-wired through a ref in four places and several carrying no styling
  at all — so the same control rendered at three different sizes and, until
  earlier in this release, in two different colours. They all go through one
  primitive. Visible where a checkbox previously had no styling: it now matches
  the rest at 14px in brand blue, and it shows a focus ring, which the bare ones
  never did.

- **A button that is working now says so consistently.** `Button` grew
  `loading`/`loadingLabel` and a leading `icon` prop, and the fifteen footers
  that assembled a busy state by hand — a `Loader2` child with its own
  `mr-1.5`, a separate `disabled`, and in one case a spinner that appeared only
  when the button had *no* busy label — now hand all of it to the primitive.
  Two small visible consequences: the spacing between a button's icon and its
  label comes from the shared `gap-2` rather than a per-call-site margin, so it
  is uniform (and 2px wider in those fifteen places); and a confirmation button
  reading "Dropping…" now spins while it does, where it used to show the words
  alone.

- **`DialogContent` defaults to `max-w-md`, and the size prop is called `size`
  on every primitive.** Of the 31 dialogs that overrode the modal width, 15
  asked for `max-w-md` and only 3 wanted shadcn's `max-w-lg` default — the
  default was simply mis-chosen for a dense desktop tool. Correcting it deleted
  15 `className`s and made a `size` variant on Dialog unnecessary, since what
  remains are genuine one-offs that read fine as explicit overrides. Separately,
  `Input`'s density variant was named `inputSize` to dodge the native HTML
  `size` attribute (character width) — but its props type already `Omit`s that
  attribute, so the workaround had outlived its reason and left the library with
  two names for one concept.

- **The MCP connector's exposed connections are now picked in the app, and the
  tools take a connection's *name*.** Two halves of the same complaint: the
  client config carried an internal uuid the user never chose and should not
  have had to see.

  Which connections the connector may reach used to live *only* in the MCP
  client's own config, as `--connections <uuid>,<uuid>`. Adding a connection
  therefore meant creating it in the app, looking its `id` up in
  `profiles.json`, hand-editing `~/.claude.json` (and Cursor's, and Codex's,
  …), then restarting each client — and a profile deleted later left a dead id
  in every one of those files with nothing to detect it. The asymmetry was the
  giveaway: `mcp_write`, the *more* security-relevant half, already lived on
  the profile and was already re-read from disk on every write attempt, so the
  coarser knob was the one nailed down. Exposure is now
  `ConnectionProfile::mcp_exposed`, ticked in **Settings → MCP** — which until
  now could offer that choice but not make it, since its checkboxes only fed
  the generated snippet — and re-read per call, so exposing one more connection
  takes effect without restarting the AI client. The generated snippets carry
  no ids at all and are the same on every machine.

  `--connections` still works and still wins when passed, pinning one client to
  a fixed set for the life of the process (see *Pinning one client to a fixed
  set* in `docs/MCP.md`); every pre-1.21 config keeps behaving exactly as it
  did. Nothing is exposed on upgrade: `mcp_exposed` defaults to `false` on
  every existing profile, so a client launched without the flag starts with
  nothing to reach until the user ticks something.

  Exposure is strictly local. `merge_into` preserves it across a shared-origin
  sync in both directions (a publisher cannot expose a database on your
  machine, and a refresh cannot take access away from a client mid-session),
  and `apply_profile_imports` clears it, so importing a colleague's bundle to
  look at it never hands your AI clients live access. The write policy rides
  along untouched — it grants nothing while the connection is unreachable.

  Every tool now accepts the connection's **name** as shown in HuginnDB, not
  just its profile id (`resolve_connection`, `src-tauri/src/mcp/mod.rs`).
  `list_connections` always reported both, and the model was still obliged to
  copy the uuid into every subsequent call. Ids still win over a colliding
  name, resolution is scoped to exposed connections only, an ambiguous name is
  refused with the candidates listed rather than guessed at, and a reference
  naming a real-but-unexposed connection now says exactly that — with the fix
  that applies to how the server was started — instead of "unknown connection".

  `docs/MCP.md` opens with a **Quick start** — four steps, no terminal — and a
  "coming from a setup made before 1.21" note, because the old muscle memory
  (edit the client's JSON, paste a uuid) still *works* and would otherwise
  never tell anyone it is no longer needed. Both are `##` sections, so the
  in-app documentation viewer renders them as their own pages in both
  languages for free.

  Under shared pools the app re-checks exposure itself on every bridged
  request rather than trusting the list the sidecar declared at handshake
  (`Exposure` in `src-tauri/src/bridge/server.rs`); a handshake happens once
  and a client holds its sidecar for days, so a snapshot would have reproduced
  the very staleness this change removes. The `Hello` frame gained an additive
  `deferExposure` flag with no protocol bump — an app that predates it enforces
  the snapshot the sidecar still sends, which is the old behaviour rather than
  a refusal, and a refusal is the one outcome the sidecar cannot degrade from
  gracefully.

### Fixed

- **Tooltips were clipped and painted over near a panel's edge.** The themed
  tooltip rendered in its place in the page rather than on top of it, so a
  scrolling container cut it off and anything stacked above the panel covered
  it — visible on the connections panel's "disconnect all" button, whose tooltip
  appeared sliced behind the title bar. It now renders above everything, like
  every other floating surface in the app, and keeps a margin from the window
  edges so it flips to the other side instead of sitting flush against them.

- **Icon buttons showed the operating system's tooltip, not the app's.** Twenty-nine
  of them — the grid footer's zoom controls, the console's toolbar, the saved-query
  row actions, the appearance panel's export and delete, and more — were `Button`s
  with a native `title`, so hovering them produced an unstyled OS tooltip on the
  system's own delay, right beside migrated buttons showing the themed one. They
  all use the themed tooltip now. The five whose appearance had to stay (an
  outlined transfer arrow, a filter button carrying a count badge) keep their
  button and gained the themed tooltip around it.

- **A focused field or toolbar control was easy to lose track of.** Sixteen
  places drew focus as `ring-1 ring-ring` — a one-pixel hairline in the theme's
  ring colour, which at that width is close to invisible on either theme. It was
  never a decision so much as the shape focus had before the visual overhaul,
  kept alive because there was nowhere to take the current treatment *from*: the
  nine dense fields in grid cells and the type pickers now use the same
  border-turns-brand-plus-soft-halo language as every `Input`, and the seven
  status-bar and switcher controls use the ringed language the segmented control
  already had. The structure editor's cell input is part of this: it was the one
  field in the app that overrode the primitive's focus with a grey border and a
  hairline, so which cell you were editing was genuinely hard to see. It no
  longer overrides anything.

- **Three theme-token bugs in shared chrome: checkboxes, inline links, and every
  hand-rolled shadow.** All three come from the same place — a call site
  spelling a colour itself instead of taking the one the design system already
  had — and all three stayed invisible until you put two surfaces side by side.

  Twelve checkboxes used `accent-primary`, which is not the blue anyone
  expected. `--primary` is near-black in light themes and near-white in dark
  ones (`index.css`), while `--brand` is the one saturated colour the app is
  allowed to spend on affordances that mean "do this". So the same control
  rendered grey in twelve places and brand blue in twenty others, sometimes on
  the same screen. Every checkbox takes `accent-brand` now. Five inline links
  had the same bug with `text-primary`, and `Button variant="link"` already
  used `text-brand` — so those five disagreed with their own primitive.

  Nine surfaces drew a raw Tailwind shadow (`shadow-sm` … `shadow-2xl`) instead
  of the `shadow-elevation-1..4` scale, three of them inside `components/ui/`
  itself. That is not just inconsistency: Tailwind's shadows are a fixed black,
  while the elevation scale mixes `--foreground`, so a raw shadow under a dark
  panel is a black smear rather than the lift it was meant to be. Floating
  panels now sit at `elevation-3` (matching the dropdown, context menu and
  select that already did) and modal surfaces at `elevation-4` (matching
  `DialogContent`).

- **Hiding a connection in a synced environment's picker didn't stick — the**
  **next sync from the origin quietly showed it again.** `visible_connections`
  (`LaunchState`, the same "DataGrip-style" filter #107 added for an ordinary
  environment) was one field doing two incompatible jobs for a mirrored
  environment: `sync_environment_bundles` treated it as the origin's true
  connection membership and overwrote it wholesale on every pull, while the
  connections tree treated the very same field as the user's own hide/show
  choice. The two only ever agreed by accident, until the next scheduled sync
  (or a manual "Sync now") reset the filter back to "show everything the
  origin publishes."

  `Environment` gained a fifth local override, `local_visible_connections`,
  alongside the existing `local_name`/`local_color`/`local_icon`/`local_theme_id`
  quartet — same shape, `Some(list)` wins over the synced value and `None`
  means "keep following the origin." `sync_environment_bundles` keeps
  overwriting `launch.visible_connections` with the bundle's real membership
  (that part was never the bug — a newly-shared connection still needs to
  show up on its own), but nothing reads that field directly anymore:
  `Environment::effective_visible_connections` resolves the override first,
  and both `get_launch_state` and `list_environments` return the resolved
  value. `save_launch_state` diverts an incoming filter into the override
  instead of the synced field whenever the active environment mirrors an
  origin, so the next sync has the real membership to compare against rather
  than the user's last chosen subset. Clearing the filter back to "show all"
  clears the override too, which is exactly "go back to following the
  origin" — a sync never publishes a narrower membership than the full
  bundle, so there was never a case where "no override" needed to mean
  anything else.

### Added

- **Insert a pipeline stage at any position, not only at the end.** A
  pipeline's order is its meaning, so the common edit was the awkward one:
  realizing a `$match` belongs *before* the `$lookup` already written meant
  appending a stage at the foot of the list and dragging it up past
  everything in between. Each stage card now offers an "insert above" of its
  own, which is what reaches every gap in the pipeline including the very
  top — the position that matters most, since filtering early is the most
  common thing a pipeline wants put in front of what's already there. It
  lives in the card header next to delete, rather than as a hover target in
  the gap between cards, since that gap already belongs to drag-and-drop's
  own drop indicator.

- **Duplicate a pipeline stage.** The companion to the insert above: a
  `$match` you've already tuned is usually the fastest starting point for the
  next one, and retyping it was the only way to get a second. The copy lands
  directly after its source — a duplicate means "another one like this,"
  which is a different relationship to the card than an insert's "make room
  here." Its body and enabled flag copy verbatim, so duplicating a stage
  you'd switched off doesn't silently switch the copy on and join the next
  preview run; its collapse state resets, since a card you just made is one
  you're about to edit.

### Changed

- **The three ways to add data on MongoDB collapsed into one split Insert
  button.** The inline draft row, the free-form document editor, and "Import
  JSON" were three separate toolbar controls for one intent, in a bar that
  already collapses into an overflow menu at ordinary widths. The button body
  still performs the plain "insert" action with a single click — the most
  frequent action in the grid, and one with no keyboard shortcut to fall back
  on — and only its chevron opens the menu holding the other two. On the four
  SQL drivers, which have no alternatives, it stays exactly the plain button
  it always was; a split control offering one choice would be worse than no
  split.

- **Column-width controls moved to the grid's footer, beside the row-zoom
  buttons.** They used to sit in the header toolbar, which split the two
  halves of one question — how wide are the columns, how tall are the rows —
  across opposite edges of the grid. It also unloads a header that was
  overfull: on MongoDB it carried ten controls and collapsed into its
  overflow menu at ordinary panel widths, and between this move and the split
  Insert button above it sheds four. A divider now separates the two footer
  clusters so they read as two groups rather than one row of four buttons.

### Fixed

- **A MongoDB collection's row total went stale after any write, and a
  failed field-list load was invisible and permanent.** Refreshing — the
  button, F5, or the refetch after a delete/insert/import — never re-ran the
  row count, because the effect that counts is keyed on the query predicate
  and nothing about adding or removing rows changes that, so the footer kept
  showing whatever total it last computed. Separately, when inferring the
  collection's fields failed, the tab recorded the error but never displayed
  it or offered a retry — the only visible symptom was the advanced filter
  dialog opening with an empty form, since it's built entirely from that
  field list. One `reload` now backs refresh, F5, delete, insert and import
  alike, and the tab surfaces the inference error — or a loading spinner
  while it's in flight — instead of staying silently dead.

- **Inferring a large MongoDB collection's fields could hang instead of
  failing, and a filtered row count could run for minutes.** `$sample`'s fast
  path needs a storage-engine precondition a time-series collection's backing
  buckets can never satisfy, so inference on one fell through to reading the
  whole collection and sorting it by a random key — which does not finish at
  tens of millions of documents, and ran with no timeout at all. A catalog
  check now skips straight to a bounded, both-ends `find().limit()` scan for
  a collection that can't take the fast path, and a slow `$sample` elsewhere
  fails over to that same scan after 2 seconds. A count against a filter — a
  full collection scan with no index to answer it — is now capped at 10
  seconds instead of running unbounded while holding a pooled connection; on
  timeout the grid falls back to showing the page range without a total,
  exactly as it already does for any other failed count.

- **The MongoDB advanced-filter button's spinner never stopped.** A stale
  `useMemo` dependency array — introduced alongside the spinner itself — left
  the toolbar rendering the first render's JSX, from before the field list
  had loaded, forever after. Reproduced on a 20,000-document collection where
  sampling is instant, which is what pointed at the memo rather than at
  anything server-side.

- **Switching the grid to list view paused on a large page, and scrolling
  never felt right afterward.** The table view has been windowed since it was
  written; the list view — one line per field per document — never was, and
  at the largest page size that's thousands of DOM nodes built in one
  synchronous commit. It's windowed now, measuring each card's real height
  dynamically rather than assuming a fixed row height: a document's height is
  its field count, which varies per document and changes when a nested value
  is folded.

- **The inline cell editor's "∅" button — one stray click from wiping a value,
  with no confirmation — is gone.** Setting a cell to `NULL` while editing it
  inline sat directly beside the text caret, and unlike the grid's other
  destructive actions it took effect the instant it was clicked. `NULL` stays
  reachable from the row's right-click menu — a deliberate second step rather
  than a key next to where you're typing. The remaining expand button now
  shows the app's themed tooltip instead of the operating system's, which
  also clears `CellInput.tsx` off the OS-tooltip adoption-debt ratchet; it
  stays a hand-rolled button rather than the shared `IconButton` primitive,
  since that primitive's smallest shape is a fixed 24px square — exactly this
  field's own height, leaving it no room to breathe inside the field's
  border. The MongoDB list view's matching "∅" button (`DocumentListView`)
  is gone for the same reason.

- **A cell being edited inline showed two nested blue squares.** The
  keyboard-active cell's `ring-2 ring-inset ring-brand` stayed lit while
  `CellInput` (or a BIT column's `<select>`) drew its own `border-brand` +
  halo directly on top of it inside the same cell — two competing focus
  outlines for one field. The outer ring is now suppressed for the exact cell
  being inline-edited, since the field's own border already says so.

- **A selected-but-not-editing cell's "view full value" button painted a
  visibly mismatched patch over the cell.** Selecting a cell (without
  entering edit mode) shows a small expand button for viewing the full value
  (issue #78); it painted a flat `bg-background` behind itself so its
  `sticky` positioning had an opaque surface to sit on, and that flat colour
  never tracked the cell's own fill — selected, zebra-striped, hovered —
  so it showed as a small rectangle a shade off from the cell around it. It's
  transparent now, the same seam class `CellInput`'s own sticky button was
  already fixed for; the accepted trade-off is that scrolling a very wide
  column while both sticky and selected can show text passing underneath it.

## [1.20.0] — 2026-08-31

### Added

- **Shared origins: local cosmetic overrides for a mirrored environment, and
  in-place editing for the publisher.** Two long-standing frictions in the
  shared-origins workflow (#108), both reported after real use rather than
  found by inspection.

  A mirrored environment's `name`/`color`/`icon`/theme used to be
  overwritten on every sync with no exception — the same "read-only, released
  only via adopt/retire" treatment its connection membership genuinely needs,
  applied to fields that only describe how the environment looks on *this*
  screen. A user who disliked a colleague's icon choice had no way to change
  it that survived the next pull. `Environment` now carries four local-only
  companion fields (`local_name`/`local_color`/`local_icon`/`local_theme_id`,
  `src-tauri/src/tab_state.rs`) that `sync_environment_bundles` never touches
  and that never travel through export or the origin document — the same
  "local decision the publisher cannot know" reasoning `merge_into` already
  applies to a connection profile's `mcp_write`/`pulse_enabled` (gotcha #56),
  extended one level up. `EnvironmentEditorDialog` writes to them (via the new
  `set_environment_local_overrides` command) instead of the synced fields
  whenever the environment being edited is mirrored, with a plain-language
  note explaining the change is local, and a "follow the origin again" action
  to drop the override. Detaching from the origin (`adopt_environment`) folds
  a set override into the now-authoritative public field rather than leaving
  two copies of the truth lying around.

  Separately: fixing a wrong value (a stale password, most often) published
  through a shared origin used to require duplicating the connection under a
  fresh id, editing the copy, republishing it, and then manually cleaning up
  the now-orphaned original once a later sync flagged it `vanished` — two app
  restarts and a leftover row if any step was missed. It turned out the
  backend never actually enforced read-only on an origin-linked profile —
  `save_profile` has no `origin_id` check at all, and already writes the
  keychain entry a republish's `fromKeychain` secret slot resolves from — the
  block was purely `ConnectionDialog` refusing to call it. The one exception
  now allowed is the origin's own publisher: `canEditInPlace` (`fromOrigin &&
  originIsPublished`) lets them correct the profile — including its password
  — in the same dialog and the same id, no duplicate, no orphan, and
  republish it from the existing origin editor when ready. Publishing,
  adopting, or retiring from that editor now also triggers a full
  `useOriginSync.syncAll()` on the spot, so this machine's own `profiles.json`
  and `vanished` state catch up immediately instead of waiting for the next
  launch or a manually-clicked "Sync now."

- **Pulse reaches the MCP connector — seven read-only tools, closing out the
  feature.** `pulse_health`, `pulse_metrics`, `pulse_top_queries`,
  `pulse_explain`, `pulse_storage`, `pulse_sessions`, `pulse_index_usage`:
  the same six views the desktop panel already showed, plus the on-disk
  history, now answerable by an AI client against any connection it's
  allowed to reach — none of the app's own UI needs to be open for a client
  to ask "how's this server doing" or "what's this connection's slowest
  statement."

  Every tool dispatches straight to the same `_inner` function its Tauri
  command already calls — `pulse_health` to `pulse_health_inner`,
  `pulse_explain` to `pulse_explain_inner`, and so on — through the same
  `BridgeRequest` fan-out every other read-only tool already uses, which is
  what makes `pulse_explain`'s safety guard (read-only, single statement, not
  itself `EXPLAIN`/`ANALYZE`) apply here with no new code: it already lived
  in `commands::pulse::validate_explain_target`, written the first time this
  tool's arrival was still "not yet" rather than duplicated now that it is.

  `pulse_metrics` is the one tool with nothing to dispatch to on the Tauri
  side under that name — it reads `pulse.db` directly, via a new
  `pulse_metrics_inner` extracted from the existing `pulse_history` command
  so the two names share one implementation. It needs no live pool at all,
  which matters for how it behaves in standalone sidecar mode: with no
  desktop app running, `pulse.db`'s own WAL journal mode is what lets the
  sidecar open the exact same file the app would and run reads against it
  concurrently with the app's sampler, rather than needing a protocol of its
  own to ask the app for the answer.

  All seven are exhaustively wired through every match `BridgeRequest`
  drives — `is_mutating` (all `false`), `label`, `connection_id_of` — so the
  compiler catches an omission rather than a request silently falling
  through to a `None`/`_ =>` default the way a write variant risks (see
  `CLAUDE.md` gotcha #49). None of the seven touch `bridged_connection_id` or
  either policy match: reads carry no `policy_id` and need none, the same
  shape every read-only tool before them already has.

- **Pulse gets a memory: `pulse.db`, a 60-second sampler, retention, and a
  Settings → Pulse panel to turn it on.** Every earlier Pulse view answered
  "how is this server right now" and forgot the answer the moment the window
  closed. This is the last piece HuginnDB's own performance promise was
  waiting on: Pulse can now be asked "how did this look last week", and
  answering that honestly meant designing the disk cost first, not
  retrofitting it.

  Sampling is opt-in **per connection** (`pulse_enabled` on the profile,
  off by default, preserved across a shared-origin sync the same way
  `mcp_write` already is) and reads only what a 60-second tick needs in one
  round trip — `SHOW GLOBAL STATUS` on MySQL, `serverStatus` on MongoDB —
  never the second, almost-static read (`SHOW GLOBAL VARIABLES`; the
  profiling level) the live panel's `health()` also makes. A tick for one
  connection failing (a dropped server, a revoked privilege) costs that
  connection a gap for the minute, never the rest of the fleet's sample.
  `sampleWhenMinimized` (on by default) trades that promise for zero server
  load whenever HuginnDB itself isn't on screen.

  The store is the one state file in this app that isn't JSON. Rewriting a
  whole blob atomically on every tick — `state_file.rs`'s pattern for
  everything else — is exactly the write amplification a time series exists
  to avoid, so `pulse.db` is a small SQLite database instead (WAL, one
  `samples(connection_id, ts_ms, metric, value)` table), opened lazily on
  first use so an install where nobody has turned Pulse on for any
  connection never creates the file. `state_file::path` still resolves
  *where* it lives — that function only ever resolved a path and made the
  parent directory, it never assumed JSON — which is what keeps the canary
  build's state isolation (gotcha #26) applying here for free. Counters are
  stored raw, the same rule the live in-memory series already follows:
  deriving a rate needs two samples and the gap between them, and a
  pre-derived rate would make a server restart indistinguishable from a real
  drop.

  Retention is a staircase, run in the same tick right after the write: full
  60-second resolution for 48 hours, downsampled to one point per 5-minute
  bucket out to the retention window (30 days by default), then deleted
  outright. A `maxDiskMb` soft cap (20 MB by default, `0` disables it) sheds
  the oldest tenth of what remains if the file is still over budget after
  that — a blunt safety valve for a fleet of connections nobody sized the
  retention window for, not the thing that owns day-to-day disk usage.

  The expanded window gains a sixth rail entry, Retrospectiva: two charts
  (queries/s, connection pressure) over a 24h/7d/30d range, reusing the
  panel's own hand-drawn `Sparkline` and a new `seriesFromHistory` that
  shares `rateBetween`'s restart-safe, uneven-interval-safe arithmetic with
  the live series rather than re-deriving it. Cache-hit history is
  deliberately not one of the two: it needs its two underlying counters
  lined up point-for-point, and downsampled history has no guarantee of
  keeping that alignment clean.

  Settings → Pulse is new: the sampler's own knobs (sample interval,
  retention, disk cap, sample-when-minimized) above a connection picker
  mirroring `Settings → MCP`'s tree — same provenance grouping via
  `buildRailSections`, same reasoning for skipping the shared-origin
  read-only carve-out (the opt-in is a local resource decision, not
  something a publisher two machines away gets a say in). Unlike MCP's
  picker, the checkbox *is* the persisted setting rather than an ephemeral
  selection for building a snippet, so toggling one writes straight through
  a new `set_pulse_enabled` command — the same "one field, not the whole
  profile" shape `set_mcp_write_policy` already uses.

  New: `pulse::store::PulseStore`, `pulse::sampler`, `prefs::PulsePrefs`,
  `ConnectionProfile::pulse_enabled`, `db::{mysql,mongo}::pulse::sample`, the
  `pulse_history`/`set_pulse_enabled` commands, `seriesFromHistory`, and the
  `PulseSection`/`PulseConnectionTree` settings components.

- **Pulse gains Sessions and Indexes — the last two rail entries the expanded
  window was missing.** Both are on-demand, manual-refresh reads: unlike the
  digest table and the storage ranking, a session list that is fifteen
  minutes stale is actively misleading, not merely dated, so neither view
  auto-polls — each has its own refresh button instead, and the read fires
  once when the rail entry is opened.

  Sessions reads `SHOW FULL PROCESSLIST` on MySQL — the same statement any
  `mysql` client runs, and unlike `information_schema.PROCESSLIST` never
  disabled by `show_compatibility_56` on a server that has moved past it —
  and the aggregation-pipeline form of `currentOp` on MongoDB. The two engines
  keep their own vocabulary rather than being translated into a shared one:
  MySQL's `Command`/`State` columns and MongoDB's `op` field and derived
  `active`/`waiting for lock`/`idle` state say what each engine actually
  means, and forcing one onto the other would just be inventing a mapping
  neither server has. MongoDB's read is deliberately narrower than MySQL's —
  `idleConnections`/`idleSessions` are both off, so an idle pool of client
  connections never shows up, since MongoDB has no cheap equivalent of
  MySQL's "Sleep" state worth surfacing and including every idle session
  would bury the operations someone actually came here to see.

  MySQL sessions also carry a best-effort blocking chain, read from
  `performance_schema.data_lock_waits` joined against `performance_schema.threads`
  — a session's own `Id`, when it is known to be waiting on a lock another
  session holds. Same degrade-not-fail shape as the rest of Pulse: a role
  without the privilege, or `performance_schema` off, just leaves every
  `blocked_by` unset rather than failing the whole read. MongoDB does not
  identify the blocker in this pass — `currentOp` has no direct "this opid
  waits on that opid" field, only `waitingForLock` plus per-operation lock
  state that would need matching lock resources across every other running
  operation to resolve correctly, and that is real, correctness-sensitive
  work left for later rather than guessed at. A blocked Mongo session still
  shows through its state.

  Indexes ranks usage since the counters were last reset, least-read first —
  the point is spotting the indexes nobody touches. MySQL reads
  `sys.schema_index_statistics` (installed on every server since 5.7.7),
  which covers every table in the current database in one round trip.
  MongoDB has no server-wide form of `$indexStats` the way `$collStats` has
  for storage, so it reads per collection instead — bounded to the twenty
  largest collections by the same footprint ranking `storage` already
  computes, on the reasoning that a dead index on a tiny collection wastes
  little while the biggest collections are where one costs the most in disk
  and write overhead. Per-index *size* is skipped on both engines on purpose:
  MySQL keeps it in `mysql.innodb_index_stats`, a system table ordinary
  accounts frequently cannot read, and MongoDB would need a second
  `$collStats` call per collection alongside `$indexStats`, doubling the
  round trips the twenty-collection bound exists to avoid. An index truly
  never read (`Some(0)`) is shown as "unused"; a server that could not be
  asked at all (`None`) reads as a dash — the two are different claims and
  collapsing them would either invent a usage figure or hide a real zero.

  New: `pulse::{SessionRow, IndexUsage}`, `db::mysql::pulse::{sessions,
  index_usage, blocking_chain}`, `db::mongo::pulse::{sessions, index_usage}`,
  the `pulse_sessions`/`pulse_index_usage` commands, and the shared
  `useOnDemandRead` hook the two new rail views are built on.

- **Pulse can EXPLAIN a statement, on both engines, straight from the digest
  table.** Every row in the expanded window's Consultas view now has a Plan
  action; clicking it wraps that row's own captured example in `EXPLAIN` and
  renders the server's read-only plan, without ever running the statement for
  real. Two pieces had to land together to make that safe rather than merely
  convenient.

  First, a runnable example. `DIGEST_TEXT` is normalised to `?` placeholders
  precisely so unrelated executions fold into one row — which also means it
  cannot be hand to `EXPLAIN`. MySQL's `QUERY_SAMPLE_TEXT` (5.7.7+) is the
  literal statement behind one of those executions, captured alongside the
  digest at no extra cost, and now travels as `TopQuery.sample`. A row with no
  sample (an ancient server, or a statement shape `explain` cannot preview)
  disables the action instead of sending a request known to fail. **MariaDB's
  fork of `performance_schema` never added `QUERY_SAMPLE_TEXT` at all**, so
  the digest read tries it first and retries once without it on
  `ER_BAD_FIELD_ERROR` (1054) — without that, a MariaDB server with
  `performance_schema` genuinely on would fail the whole Consultas read and
  look exactly like one with it off, which is precisely the failure this
  view's degrade-don't-fail design exists to avoid.

  Second, MongoDB's Consultas view existing at all: `system.profile` is now
  read and grouped into the same `TopQuery` shape MySQL's digest table
  produces — by the server's own `queryHash` where the entry carries one,
  falling back to namespace + command on older servers. A `find`'s filter
  becomes both the row's label and its `sample`, rendered as the same
  `db.coll.find({…})` shell syntax the query editor speaks — reusing that one
  parser (rather than inventing a second) is also what lets `pulse_explain`
  replay it: parse the sample back into a filter, wrap it in MongoDB's own
  `explain` command at `"queryPlanner"` verbosity (never a level that would
  execute the statement), and hand back the reply as-is. `update`/`delete`/
  `insert` entries still group and rank normally — they say where the time
  went — they simply carry no `sample`, since nothing here replays a write.

  The guard the two engines share lives in one place
  (`commands::pulse::validate_explain_target`), ahead of any future MCP tool
  that reaches the same `pulse_explain_inner`: read-only only, refuses a
  statement that is itself `EXPLAIN`/`ANALYZE` (the latter actually *runs*
  the target, defeating the point of a preview), and refuses a stray `;` that
  could smuggle a second statement past the first check. New:
  `pulse::ExplainPlan`, `db::mysql::pulse::explain`,
  `db::mongo::pulse::{top_queries, explain}`, the `pulse_explain` command.

- **Pulse reads MongoDB too.** `serverStatus` fills the same four tiles and the
  same alert rules as MySQL, and `$collStats` fills the storage ranking — the
  one `$collStats` call the schema explorer already makes, not a `collStats` per
  collection. The canonical metric catalogue is what makes this a mapping table
  rather than a second panel: `connections.current` becomes
  `connections_active`, WiredTiger's cache accounting becomes the same hit-rate
  pair, and metrics MongoDB simply has no equivalent for (temporary tables
  spilling to disk, the slow-query counter) are **absent** rather than zero, so
  their tiles read as an em dash instead of a healthy nought.

  Three mappings that are not obvious and are wrong in an invisible way if
  rushed. `queries` sums every `opcounters` entry rather than reading one:
  `query` alone omits the `getmore`s a cursor-heavy workload is mostly made of.
  `connections_max` is `current + available`, because MongoDB reports headroom
  and not a ceiling — reporting `available` would show a server at 43 % as
  nearly idle. And every number is read as whichever BSON width the server
  chose (the same counter is `Int32` on a quiet server, `Int64` once it grows,
  `Double` inside the WiredTiger block), because a typed read would silently
  miss the metric on exactly the servers worth measuring.

  Storage maps cleanly: `storageSize`, `totalIndexSize`, and `freeStorageSize`
  into the same data / indexes / free split MySQL's `Data_free` already meant.
  Statement statistics are the one read still missing on MongoDB — its
  equivalent is the profiler's `system.profile`, a different shape and an
  opt-in of its own — and the section now says which server-side switch would
  fill it rather than showing MySQL's wording to a Mongo user.

- **Pulse expands into a window of its own.** The ⤢ button in the panel's
  header opens a real OS window measuring that connection — wide enough for the
  full digest table and the whole storage ranking, and free to sit on a second
  monitor while the workspace stays where it is. A rail down the left carries
  the views that have a read behind them today (Status, Time spent, Storage);
  Sessions, Indexes and the history retrospective join it as theirs land,
  because a rail entry with nothing behind it is worse than an absent one.

  It is **not** a workspace tab and not a detached-tab window either. Pulse is
  context, not a document: it has no `TabKind`, nothing in `useTabs`, and
  nothing in the persisted tab state, so the window carries one connection id
  and nothing else (`open_pulse_window` / `take_pulse_window_intent`, mirroring
  the existing intent-stash pattern). The dock panel keeps working while it is
  open and the two **share one clock** — the live series lives in a store, not
  in either component, so two surfaces on one connection are still one probe
  every five seconds.

  The tiles, the alert list and the storage legend are now shared components
  parameterised by density rather than written twice, and `usePulseView`
  derives every figure in one place. Two surfaces computing "queries per
  second" separately is how they would eventually disagree about what it means.

- **Pulse fills the panel: where the time goes, and where the disk went.** The
  first cut showed four tiles and the alerts and then left most of a tall
  panel empty. Two sections now follow them: the statements the server has
  spent the most time on (`performance_schema`'s digest table — normalised
  text, average latency, executions, rows examined, and a red figure when the
  statement resolved without using an index) and the biggest relations
  (`SHOW TABLE STATUS`, split into data / indexes / free space, bars scaled
  against the largest so the section reads as a ranking). Three rows each; the
  remaining seventeen are already fetched and waiting for the expanded window.

  Neither is polled. Both are read when Pulse becomes visible and then at most
  every fifteen minutes, and a cached answer younger than that is reused — so
  flipping the right dock between Saved and Pulse cannot re-issue the most
  expensive statement Pulse knows how to send. A refresh that fails keeps the
  last good answer on screen with the failure noted beside it, because a server
  can refuse one of the two reads while answering the other perfectly well, and
  blanking a section that was fine a minute ago helps nobody.

  Two notes on the numbers. Latency is the **mean**, not p95: MySQL 8.0 does
  expose `QUANTILE_95` in the digest table but 5.7 has no such column and a
  query naming it simply fails there — one figure that works everywhere beats
  two code paths, and the percentile belongs with the expanded Queries view
  where there is room to say what it is a percentile of. And `SHOW TABLE
  STATUS` rather than `information_schema.TABLES`, the same call the schema
  explorer already makes: `information_schema` can wait indefinitely on an
  InnoDB metadata lock, which is exactly the server someone has Pulse open
  about.

- **HuginnDB Pulse — the server's vital signs in the right dock.** HuginnDB
  could say what is *in* a database and nothing about how the server holding
  it is doing; answering "is this thing all right?" meant leaving the app.
  Pulse is the first slice of that answer: a compact panel in the right dock
  (selected from the activity bar, alongside Saved queries) showing four live
  tiles — queries per second, connection pressure, threads running, buffer-pool
  hit rate — with a sparkline each, plus the alerts derived from them. MySQL
  only in this release; the other engines say so explicitly rather than
  rendering a column of zeroes.

  What it costs is the part that was designed first. The panel polls every five
  seconds and **only while it is on screen**: switching the dock to Saved,
  collapsing it, or minimising the window all stop the clock, and a connection
  nobody has looked at is never sampled at all. One probe is one
  `SHOW GLOBAL STATUS`; a sample still in flight when the next tick fires skips
  that tick, so a struggling server never accumulates a queue of probes from
  the thing measuring it. The live series lives in a store rather than in the
  panel, so the expanded window (next release) will share one clock with it
  instead of doubling the load.

  Three decisions worth knowing. Counters cross the IPC boundary **raw**, as the
  server reports them, and rates are derived on this side — which is what makes
  a server restart detectable (a counter that goes *down*) instead of being
  smoothed into a plausible dip. Metric names are normalised to an
  engine-independent catalogue (`pulse::METRICS`), so MySQL's
  `Threads_connected` and MongoDB's `connections.current` become one tile and
  one future MCP argument; an engine with no equivalent for a metric omits it,
  because a missing reading and a zero are different answers. And the
  buffer-pool figure is computed over the **last interval**, never the server's
  lifetime: a box up for six weeks has a flattering lifetime ratio no matter
  how badly it is thrashing right now.

  New: `src-tauri/src/pulse/`, `src-tauri/src/db/mysql/pulse.rs`,
  `src-tauri/src/commands/pulse.rs`, `src/components/pulse/`,
  `src/lib/pulse/`, `src/stores/session/pulse.ts`. The mapping table, the rate
  arithmetic and the alert thresholds are all pure and tested — a wrong metric
  mapping does not fail, it silently plots the wrong counter.

- **The CLI connect flow now follows environments instead of ignoring them.**
  It predates environments entirely, so `--connect-profile[-id]` always
  connected in whatever environment happened to be active, even when the named
  profile actually belonged to a different one — silently landing the
  connection somewhere the user wasn't looking. `useCliIntents`'s new
  `connectToProfile` helper asks the backend which environment(s) reference the
  target connection (a new `find_environments_for_connection` command, built on
  the same `referenced_profile_ids` the environment exporter already used) and
  switches there first when the active environment isn't among them.
  Separately, an ad-hoc launch (`--host …` / `--uri …`) used to always mint a
  brand-new `ephemeral` profile, even when an identical one was already saved —
  it now reuses an existing non-ephemeral profile with the same
  driver/host/port/database/username (or the same connection string, for a
  `--uri` launch) through the same environment-following path, and only falls
  back to creating a throwaway profile when nothing matches.

### Added

- **Compass-style autocomplete in the aggregation editor.** Typing `$` in a
  stage body now offers the source collection's field names alongside the
  existing operator/constructor suggestions, and a `$lookup` stage offers
  collection names for `from`, the source collection's fields for
  `localField`, and the referenced collection's fields for `foreignField`.
  Built entirely on data already in memory — `useSchema`'s existing
  collection/field cache, the same one the schema tree already populates —
  so opening the editor costs at most one field-sampling query per
  collection actually referenced, never one per keystroke. See gotcha #57 in
  `CLAUDE.md` for how the completion provider was extended without
  reintroducing the "N duplicate providers" bug gotcha #9 already covers.

### Changed

- **The right dock is a selection, not a boolean — groundwork for HuginnDB
  Pulse.** `useSessionPanelLayout` tracked the right side panel as
  `savedOpen: boolean`, which was exactly right while Saved Queries was its
  only occupant. Pulse (a per-connection performance panel, landing next)
  docks in the same slot, and two independent booleans cannot express a
  single slot: they let both be "open" at once with nothing deciding which
  one the 260px of screen actually shows. The field is now
  `rightPanel: "saved" | "pulse" | null`, and the right activity bar behaves
  as a selector — clicking the active entry collapses the dock, clicking
  another switches to it. Three consequences worth knowing: each occupant
  keeps its **own** persisted width (`savedWidth`, `pulseWidth`), since the
  comfortable width for a list of query names is not the one for a column of
  metric tiles; `lastRightPanel` is what the header's `PanelRight` button
  reopens, because that button toggles the *edge* and always did, so it now
  reads `panels.rightDock` instead of naming one of the panels it might
  bring back; and the persisted layout gained a real `version: 1 -> 2`
  migration mapping `savedOpen: true` to `rightPanel: "saved"` rather than
  the `return DEFAULTS` the previous `migrate` fell back to for any unknown
  version — dropping someone's schema width and console height for a rename
  is not a trade worth making. `src/stores/session/panelLayout.test.ts` is
  new and covers both halves: the characterization cases (defaults, clamp
  behaviour, rehydration) were written against the old store before any of
  this changed, and the migration cases assert the carried-over fields
  survive.

- **Frontend performance pass.** A real regression reported on modest
  hardware — a 10k-row table in list mode degrading to unusable, and a
  broader shell choppiness — that turned out not to involve the Rust backend
  at all: every entry below removes one concrete, file-and-line-identified
  cost in the React/DOM layer. Landed incrementally as its own series of
  commits, one bullet per commit.

- **Color tokens skip the `color-mix()` layer entirely when no `/modifier` is
  used.** `2ecaaf7` (1.19.0's `light-dark()` migration) moved every Tailwind
  color token from `hsl(var(--x))` to
  `color-mix(in srgb, var(--x) calc(<alpha-value> * 100%), transparent)`, so
  that `bg-brand/25`-style alpha modifiers kept working once each token
  became a full `light-dark(...)` value (which `hsl()` cannot wrap). That
  was applied uniformly, on purpose, including to colors nobody ever uses
  with a modifier — but it meant every opaque color paid a `color-mix()` +
  `calc()` on every read, and `border-border` in particular backs
  `* { @apply border-border }` in `index.css`, i.e. the `border-color` of
  every DOM node in the app. `tailwind.config.js`'s new `colorToken()`
  helper returns the bare `var(--x)` when Tailwind calls it with no alpha
  modifier (or an explicit `/100`) and the same `color-mix()` formula
  otherwise, and `corePlugins` now disables the legacy
  `bg-opacity-*`/`border-opacity-*`/`text-opacity-*`/`divide-opacity-*`/
  `ring-opacity-*`/`placeholder-opacity-*` utilities (unused in `src/`),
  which is what routes a classless `bg-card` through Tailwind's plain
  no-modifier call instead of the `--tw-bg-opacity` custom-property
  indirection those utilities require. Visually identical in both color
  modes and every built-in theme; verified by compiling real utility
  classes through the installed `tailwindcss` engine and comparing the
  emitted declarations byte-for-byte against the pre-`colorToken()` output
  (`src/lib/tailwindColorTokens.test.ts`) for every class that actually uses
  a `/modifier`, plus the `from-brand` gradient stop that exercises
  `opacityValue: 0` — the one case where a falsy guard (`!opacityValue`
  instead of `opacityValue === undefined`) would have silently rendered the
  "fade to transparent" stop as fully opaque instead.

- **List mode no longer keeps the table view's virtualizer and
  `useReactTable` machinery running underneath it.** `DataGrid` uses one
  `<div ref={scrollRef}>` for both `viewMode`s, and the table-mode
  `useVirtualizer`/`useReactTable`/`getCoreRowModel()` pipeline used to run
  unconditionally even while `DocumentListView` was the thing actually
  rendered inside that scroll container. With the virtualizer's own virtual
  size (row count × the fixed row height, a couple thousand px) wildly out
  of sync with the list's real, much taller content, its computed visible
  range changed on almost every scroll event — and each change flushed a
  synchronous full-grid re-render (`flushSync`, via `@tanstack/react-virtual`'s
  adapter, which re-renders unconditionally without the `directDomUpdates`
  option this grid doesn't pass). `useVirtualizer` now takes
  `enabled: viewMode !== "list"` (it cleans up its listeners internally and
  re-subscribes on its own switching back to table mode) and
  `useReactTable` is fed a stable, empty `data` array in list mode instead
  of the real rows, so `getCoreRowModel()` stops building a full `Row`/`Cell`
  tree for rows nothing renders. This is the direct fix for the reported
  "100-row page, list mode, 10k-row table" degradation — the next entries in
  this pass make the list itself cheap per row.

- **List mode's per-row `memo()` now actually bails out, and a collapsed
  container stops paying for its hidden children.** Three independent fixes
  in `DocumentListView`/`documentTree`:
  - `DocumentCard` was already wrapped in `memo()`, but never once bailed
    out: `onFieldSave`/`onFieldDelete`/`onDeleteRow` arrive as plain function
    declarations recreated by `TableDataTab` on every render, and
    `onExpandField` as an inline arrow from `DataGrid` — a fresh identity on
    every render of something several layers up, every time, regardless of
    whether that particular row's own data had changed. Those four
    callbacks are now mirrored through a ref (`callbacksRef`, the same
    pattern `DataGrid`'s `interactiveRef`/`rowCallbacksRef` and `GridRow`'s
    own `callbacksRef` already use) and read at call time instead of being
    passed as props; `DocumentCard` receives only booleans
    (`hasFieldSave`, `documentMode`, …) for which affordances are available,
    which — being primitives — compare cheaply and correctly under `memo()`.
  - `FieldRow` gets the identical treatment one level down: its ~13 inline
    per-field callbacks (recreated for every field of every card, every
    render — tens of thousands of closures on a wide page) are replaced by
    one stable `actionsRef`, whose methods take the field they act on as an
    argument, and `FieldRow` itself is now `memo()`-wrapped for the first
    time.
  - `flattenDocument` (`documentTree.ts`) used to materialise a `[key,
    value]` tuple per child of a container — including a *collapsed* one —
    just to read `.length` off the result. It now reads the count directly
    (`.length` / `Object.keys().length`) and only walks into children when
    the container is actually expanded, so a collapsed 10,000-element array
    costs O(1) instead of O(children) on every render of the memo above.

  Also removed: a `useTranslation()` subscription per `DocumentCard` and
  per `FieldRow` (up to ~4,000 combined on a wide page — each a live
  i18next subscription), replaced by one subscription in `DocumentListView`
  and a `labels` object of precomputed strings (recomputed only on an
  actual language change); and a `columns.find()` per field per render to
  resolve a SQL column's catalog type (O(fields × columns), ~160,000 string
  comparisons on 100 rows × 40 columns), replaced by a `Map` built once per
  column list (`typeTextFor`, `documentTree.ts`).

  Verified with a new regression test
  (`src/components/grid/DocumentListView.test.tsx`) that would have caught
  the original bug: it re-renders the list with a brand-new `onExpandField`
  identity (exactly what `DataGrid` does today) and asserts `DocumentCard`'s
  render body does not run a second time.

- **A sash drag stopped writing to `localStorage` ~60 times a second and
  stopped re-rendering the whole shell on every frame.** `Sash.tsx` called
  `onResize(delta)` synchronously on every `pointermove` (~120Hz observed),
  and each of the four call sites (`AppShell`'s Schema/Saved panels,
  `ConsoleDock`, `IslandShell`'s cell-editor split) wired that straight into
  `useSessionPanelLayout`'s `persist` middleware — which `JSON.stringify`s
  the whole store and writes it to disk on every `set()`. The drag mechanics
  now live in a new `useSashDrag` hook that coalesces `pointermove` into one
  `onResize` call per animation frame (summing the deltas dropped in
  between, never discarding them — dropping would make the panel edge trail
  behind the cursor), and the four call sites share one new `nudgePanel(key,
  delta)` store action instead of each computing `current + delta` in their
  own render scope (which was also a latent bug: at the clamp boundary, the
  callback's closed-over `current` could already be stale relative to the
  store, letting the pointer visibly outrun the sash). The store's
  `persist` storage is now trailing-edge throttled to 250ms with an
  explicit `flush()` the four call sites invoke on `onDraggingChange(false)`,
  so the on-disk value is never more than one frame behind at the moment
  the user actually lets go.

  Also: `AppShell` no longer subscribes to `schemaWidth`/`savedWidth`
  directly — that subscription re-rendered its entire child tree
  (`IslandShell`, `ConsoleDock`, the right activity bar) on every drag
  frame. The two side panels are now `SchemaSidePanel`/`SavedSidePanel`,
  each owning its own width subscription, and each renders its panel
  content (`SchemaPanel`/`SavedPanel`) as a module-level, stable React
  element — the same element reference every render — which is what lets
  React bail out of reconciling that whole subtree even while the wrapper
  itself re-renders for the width. `CollapsiblePanel`'s fixed-size inner div
  gets `contain: layout style` (safe: fixed size, parent already clips with
  `overflow-hidden`), and the outer wrapper gets `will-change` only while a
  drag is live, not permanently.

- **Monaco's `options`/`onChange` are now stable references across renders,
  on all seven surfaces that mount one.** `@monaco-editor/react`'s
  `<Editor>` runs `editor.updateOptions(options)` in an effect keyed on
  `[options]`, and its content-change wiring is a second effect keyed on
  `[isEditorReady, onChange]` that does `dispose()` +
  `onDidChangeModelContent(...)` on every change — but every one of the
  seven call sites (the query editor, the Console detail pane, the cell
  editor, the DDL preview, the pipeline/aggregation editor, the view
  editor, the JSON Schema body editor) built `options` as a fresh object
  literal and `onChange` as a fresh inline arrow directly in JSX, so Monaco
  reconfigured itself — and tore down and re-registered its content
  listener — on every render of the surrounding component, regardless of
  whether any actual preference had changed. New
  `src/lib/monaco/useEditorOptions.ts` is a thin, named `useMemo` wrapper
  (the point isn't a new mechanism, it's that the memo lives in one place
  other call sites can copy correctly instead of being hand-rolled seven
  times with seven chances to get the dependency array wrong) paired with
  `useCallback` on each `onChange`. Depends on the full `EditorPrefs`
  object as returned by `usePreferences(selectEditorPrefs)`, which is
  referentially stable by that selector's own contract, plus any
  call-site-specific extra as a primitive (never an inline object, which
  would be a fresh reference every render and defeat the memo the same way
  the original bug did). `@monaco-editor/react`'s `Editor` component is
  itself already `memo()`-wrapped by the package, so with both props
  stable it now skips re-rendering entirely on an unrelated parent render.

- **`content-visibility: auto` on the schema tree's per-connection subtree
  and per-section row list.** With the tree filter active there can be
  thousands of rows across every open connection's expanded subtrees, all
  of it real DOM (the tree isn't virtualized, see the "Deferred" section
  below for why not yet). `content-visibility: auto` skips style
  recalc/layout/paint entirely for whatever's outside the tree's scroll
  viewport, without removing anything from the DOM — which matters because
  `moveRowFocus`'s keyboard navigation walks `[data-tree-row]` via
  `querySelectorAll` and would silently stop seeing off-screen rows if they
  were actually virtualized away. `SchemaTableSection`'s row list gets an
  exact `contain-intrinsic-size` (`items.length * 24px` — rows are a fixed,
  known height) rather than a guess; the per-connection subtree wrapper in
  `ConnectionsTree` gets an approximate one (`auto 300px`, self-correcting
  once the browser has measured the real subtree once). Pure CSS, no
  behavior change — verified manually with the filter active, watching
  DevTools' Rendering panel.

- **Typing in the schema tree's filter no longer re-renders the whole tree
  before the debounce has done anything.** `ConnectionsTree` subscribed to
  `useTreeSearch`'s raw text directly (to pass it down to `TreeFilterBox` as
  a `value` prop) — the raw needle changes on every keystroke, and
  `ConnectionsTree` sits above every connection row and its expanded
  subtree, so every keystroke re-rendered all of it, 180ms before the
  debounce (`TREE_SEARCH_DEBOUNCE_MS`) ever committed anything for the
  subtrees to actually filter by. `TreeFilterBox` now reads and writes the
  raw needle, owns the debounce effect, and handles every key the box reads
  (`Backspace` to peel a scope level, `Enter` to commit immediately) itself
  — `ConnectionsTree` keeps only `needle`/`patterns`/`scope`, which change
  once per debounce fire, not once per keystroke. `ArrowDown` is the one
  key that still needs to leave the box (moving focus into the row list
  needs the tree's own DOM via `moveRowFocus`), so it's the one thing still
  wired through a prop (`onArrowDown`). Preserves every documented
  invariant of the search path: still exactly one debounce; clearing the
  box still commits immediately; typing still never opens a connection
  pool; a focus request still selects the box's contents; Backspace on an
  empty box still peels one scope level.

- **A connection row is now a real component, and a real fix for a group
  header remount bug.** `ConnectionsTree`'s `renderConnection(p)` was a
  plain function CALLED per row (returning JSX directly), never rendered as
  `<renderConnection />` — so it was never a component boundary at all,
  and every row's JSX was reconciled as part of `ConnectionsTree`'s own
  render pass with nothing for React to bail out of. It's now
  `ConnectionTreeRow`, `memo()`-wrapped, in its own file. Its four
  callbacks (row click, disconnect, reconnect, narrow-to-scope) are handed
  down through a ref rather than as plain props or `useCallback`s — several
  of them close over other per-render closures in `ConnectionsTree`
  (`filterFolds`, `setCollapsed`, `matchCounts`, …) that aren't themselves
  memoized, so a `useCallback` here would either go stale (an incomplete
  dependency array) or buy no stability at all (an exhaustive one, since
  most of those deps change often); a ref sidesteps the question the same
  way `DataGrid`'s `rowCallbacksRef` and this pass's own
  `DocumentListView` fix already do.

  Separately, and this one is a real bug rather than a missed
  optimization: `GroupHeader` (a folder's collapsible header) was a
  `function GroupHeader(...)` DECLARED INSIDE `ConnectionsTree`'s own
  render body and used as JSX. A function declared inside a component gets
  a brand-new identity every render, and React reads a changed element
  *type* as "this is a different component" — so every render of
  `ConnectionsTree` unmounted and remounted every group header. Moved to
  its own module-scope, `memo()`-wrapped file, which is what makes a
  component safe to memoize in the first place (an identity that doesn't
  change is the precondition memo() needs, not an optimization on top of
  it).

- **`memo()` across the schema tree's explorer family, and — this is the
  part that actually made it useful — a prop that used to invalidate every
  row on the page whenever any one of them changed.** `SchemaExplorer`,
  `SingleDbExplorer`, `MultiDbExplorer`, `TableSection` and `TableRow` are
  now all `memo()`-wrapped, but wrapping `TableRow` alone would have done
  nothing: it took the connection's WHOLE per-connection schema slice
  (`cs`) as a prop and read three things out of it (whether its own node
  was expanded, its own columns, its own column-load error) — and
  `TableDataTab.tsx` already documents that loading any table's columns
  writes a fresh `columns` map reference for the *whole connection*. So
  expanding one table row invalidated the memo of every OTHER row on the
  same page. `TableRow` now takes those three values as their own props
  (`expanded`/`columns`/`columnError`), computed once per row by
  `TableSection` — which is what turns "a toggle re-renders 500 rows" into
  "a toggle re-renders 1".
  - `SingleDbExplorer`'s `tableActions` bundle (the object `TableSection`/
    `TableRow` receive for open/refresh/rename/drop/empty) was rebuilt as a
    fresh object on every render, which alone would have defeated both
    memo()s downstream regardless of the `cs` fix — wrapped in `useMemo`,
    placed ABOVE the `if (!cs)` early return for the same load-bearing
    reason the file's existing `bySchema`/`schemas` memo already has to be
    (a hook after a conditional early return is a Rules-of-Hooks violation
    the moment `cs` can flip to `undefined` between renders, which is
    exactly the multi-DB "several nested explorers unmount while
    `byConnection` settles" scenario this file's header comment already
    warns about).
  - `ConnectionsTree` had its own SECOND wide subscription to
    `useSchema.byConnection` (`useTreeMatchCounts`'s already had the first),
    used only for the row's loading spinner. New
    `useLoadingConnectionIds` (next to `useTreeMatchCounts`, same file)
    narrows that to a `Set<string>` of ids currently loading — restoring
    that file's own doc comment's claim to be the app's one wide
    subscription to that map.

- **One derivation over open tabs instead of two per schema-tree row.**
  `SchemaTableRow` ran `useTabs((s) => s.tabs.find(...))` and
  `useTabs((s) => s.tabs.some(...))` itself, each an O(tabs) scan — both
  return primitives, so neither breaks gotcha #1 or re-renders a row that
  isn't affected, but neither avoids *running*, either. 500 rows × two
  O(tabs) scans is 1,000 iterations on every `useTabs` write, and typing in
  the SQL editor is exactly such a write, once per keystroke (fixed
  properly one commit later, but this scan was real regardless). New
  `useOpenTableKeys` (`src/lib/schema/useOpenTableKeys.ts`) computes both
  answers — the active table's key and the set of every open table's key —
  in one pass, called once per explorer render rather than once per row,
  and hands the result down as two props (`activeTableKey`,
  `openTableKeys: ReadonlySet<string>`) threaded through `TableSection`.
  Each row's own membership check (`openTableKeys.has(...)`) is what
  actually feeds its `isOpen`/`isActive` state, so as long as that row's own
  membership hasn't flipped, its props stay the same primitives they were —
  keeping the previous commit's `TableRow` memo bailout intact. The `\0`
  key separator is written as the escape (`tableTabKey`), never a literal
  NUL byte — a NUL byte made the whole file binary to git once already (no
  diff, no review, no grep).

- **A keystroke in the SQL editor no longer fans out into the window title,
  dockview's tab-strip machinery, a stale-comment status-bar re-render, and
  N separate disk-save subscriptions.** `updateQuery` (`useTabs`) replaces
  the whole `tabs` array on every keystroke — correct, since the query text
  lives on the tab object — but several unrelated listeners were keyed on
  `tabs` itself rather than on whether anything they actually cared about
  had changed:
  - `WindowTitleSync` recomputed the OS window title AND made the
    `setTitle` IPC call in one effect keyed on `[tabs, activeId, profiles,
    selectedConnectionId, appName]`. The title text almost never changes
    while typing (it depends on which connection/table is active, not the
    SQL body), so the computation is now a separate `useMemo` and the IPC
    call is gated on `[title]` — a string, so it only fires when the
    *rendered* title actually changes.
  - `TabbedArea`'s panel-sync effect (`syncTabPanels`) only adds/removes
    dockview panels, so it only needs to know the tab *identity* changed,
    not that some tab's own field changed — same for the edge-fade effect
    just below it, which used to tear down and recreate its whole
    `ResizeObserver` + scroll listener on every keystroke. Both are now
    keyed on a `tabs.map(t => t.id).join("\0")` signature instead of `tabs`
    itself, reading the live array via `getState()` where the actual diff
    needs full tab data.
  - `StatusBar` selected `s.tabs.find((t) => t.id === s.activeId)` for its
    only use — `activeTab.connectionId` — but `.find()` returns a *new*
    object reference after `updateQuery` replaces that exact tab, defeating
    the Zustand selector optimization the file's own header comment
    promises. Narrowed to select `connectionId` directly (a primitive), and
    the stale "`.find()` is stable" comment is corrected in the same
    change.
  - `persistedTabs.ts` registered one `useTabs.subscribe(...)` PER tracked
    connection, so N live connections meant N debounce-timer resets per
    keystroke instead of one. Consolidated into a single shared
    subscription that fans out to every id in the internal registry,
    registered on the first connection and torn down once the registry is
    empty — the per-connection lifecycle (`flushTabState`,
    `subscribedConnectionIds`, the environment-switch `saveSuspended` gate)
    is otherwise untouched, since none of it depended on *how* the
    subscription was wired, only on the registry itself.

  Deferred (would need the user's go-ahead first): moving the SQL draft
  itself out of `useTabs` into its own store. That's the root fix — typing
  would then touch nothing the tree, status bar, title sync or dockview
  observe at all — but it changes the persisted tab shape and the
  `persistedTabs.ts` hydration/`replaceAll` paths, which has the shape of a
  schema migration rather than a render-path fix. The five fixes above
  may already be enough on their own.

- **A collapsed side/bottom panel now unmounts its content instead of
  quietly running forever behind a zero-width wrapper.** `CollapsiblePanel`
  (the shell's schema/saved/console/side-editor slots, since the move off
  dockview) only ever animated `width`/`height` between 0 and the persisted
  size — the children were always mounted, collapsed or not, which was
  invisible for a plain tree/list but not for `SideEditorPanel`: it keeps a
  live Monaco instance and its own effects running the entire session even
  when the panel has never been opened. Children now unmount once the
  *closing* transition finishes (`onTransitionEnd` on the wrapper itself,
  ignoring anything bubbling up from inside `children`) — not the instant
  `open` flips to `false`, which would pop the content out from under the
  still-animating wrapper — and remount immediately on reopen; the inner box
  also gets `content-visibility: hidden` while collapsed, for whatever stays
  mounted anyway. Two call sites can't take the default: `SavedQueriesPanel`
  (an unsaved search filter, an open rename dialog) and `SideEditorPanel`
  (an in-progress edit, its dirty-tracking baseline, parked per-tab sessions)
  both hold local component state a remount would silently discard, so both
  pass the new `keepMounted` escape hatch instead of losing it. The schema
  panel and the console dock take the new default — their state already
  lives in stores, not in the component tree.

- **`TableDataTab` was rebuilding `onCellSave` — and with it every column
  definition in the grid — on every one of its own renders, remounting the
  entire table body.** `useGridColumns`'s own header comment already spells
  out why this is expensive: TanStack's `flexRender` treats `columnDef.cell`
  as a component *type*, so a rebuilt `columns` array is a new element type
  for every cell, and React unmounts/remounts the whole `<tbody>` — the
  cursor-jumps-to-the-end bug, at table-body scale. `onCellSave` is a listed
  dependency of that memo, but `TableDataTab` defined it (and the `saveField`
  it wraps) as a plain function declaration, recreated fresh every render —
  which for a table tab, given how often its own state changes (page, sort,
  search-as-you-type), was often. Both are now `useCallback`s with an
  exhaustive dependency list, so their identity — and `useGridColumns`'s
  `columns` — only changes when something that actually affects the query
  (pk columns, catalog types, connection/schema/table, `fetchData`) does.
  `onNavigateFk` and the inline `onSelectionChange` had the same shape of
  bug one level down: both are direct (non-ref) props on the already-memoized
  `GridRow` (`components/grid/GridRow.tsx`), so an unstable identity there
  defeated that memo on every row, every render, regardless of the column
  fix above. `pkColumnNames` (`pkColumns.map(...)`) and the `searchHistory`
  fallback (`filterHistory ?? []`) had the exact same problem one line each —
  a fresh array on every render, the second one only when a connection has
  no history yet, same trap `NO_ROWS` (this file's own `commit 1`) exists to
  avoid — both fixed the same way: `useMemo`/a module-level empty-array
  constant. The four toolbar/footer content blocks (`leadingToolbar`,
  `insertExtraContent`, `trailingToolbar`, `footerContent`) are also now
  memoized, which required stabilizing the export/import handlers they
  close over (`exportFull`, `exportFiltered`, `importCollectionJsonForTab`)
  the same way — without that, wrapping the JSX in `useMemo` while it still
  captured a fresh closure every render would have been a no-op. `GridRow`'s
  own header comment, which asserted these values "stay referentially
  stable" without that actually being true, is corrected to say what makes
  it true and to warn that the memo fails open (silently, not loudly) if a
  future call site breaks the contract again. Added
  `useGridColumns.test.tsx`, a characterization test pinning the dependency
  array's actual behavior: stable input in → stable `columns` out, an
  `onCellSave`/`resultColumns` identity change rebuilds it, and mutating
  `interactiveRef`'s *contents* (a plain click) does not.

- **The query editor's run timer ticked every 50ms in `QueryEditorTab`
  itself, re-rendering the whole tab — Monaco included — twenty times a
  second for every query that ran.** `elapsedMs` existed purely to feed the
  small `QueryTimer` badge next to the Run button, but the `setInterval`
  driving it lived in the parent as plain `useState`, so each tick was a
  state update on the same component instance hosting the SQL editor.
  Extracted `useElapsed` (`src/lib/useElapsed.ts`): a small hook owning the
  ticking `elapsedMs`/frozen-outcome state and a stable `start`/`stop`
  pair. `QueryTimer` now calls it itself and exposes `start`/`stop` through
  `useImperativeHandle`, so `QueryEditorTab` drives the timer via a
  `queryTimerRef` — `queryTimerRef.current?.start()` /
  `.stop(ok)` — without ever subscribing to the value that changes on
  every tick. `runQuery`/`runBatch` lost `startTimer`/`stopTimer` from
  their own dependency arrays as a result: a ref read needs no entry.
  Added `useElapsed.test.ts` with `vi.useFakeTimers()`, covering the tick
  cadence, freezing on `stop()`, a second `start()` resetting and not
  double-ticking, and the interval actually clearing on unmount.

- **Investigated, and built the groundwork for, gating per-tab work while a
  tab is in the background.** `TabbedArea`'s own header comment states the
  design on purpose: every open tab keeps its own mounted React tree for
  its whole life, specifically so switching tabs doesn't reset a table's
  filter draft or a query editor's scroll position (gotcha #10 in
  `CLAUDE.md`). That means a query's run timer, a grid's virtualizer, or
  any other recurring per-tab work keeps running for tabs nobody is
  currently looking at — not by a bug, by the same design that makes
  switching tabs feel instant. Unmounting background tabs to stop that
  work was considered and rejected: it would reintroduce exactly the state
  loss `TabbedArea` exists to avoid, for a cost that (per the tick-scoping
  fix two entries above) is now mostly confined to the one small component
  actually doing the ticking rather than the whole tab. What's added
  instead is `useIsPanelVisible` (`src/lib/tabs/useIsPanelVisible.ts`): a
  small hook reading `DockviewPanelApi.isActive`/`isVisible` — both already
  handed to every panel component as `props.api`, no group-level
  bookkeeping needed — so a future consumer can ask "is anyone even seeing
  this?" without unmounting anything. Not wired into `QueryTimer` or the
  grid's virtualizer in this pass: doing that safely needs auditing each
  consumer for what "paused while backgrounded" should actually mean (does
  a backgrounded query's timer freeze or keep counting for when the user
  switches back?), which wants its own scoped change and testing rather
  than riding along here. Covered by `useIsPanelVisible.test.ts` against a
  minimal fake of the two events it reads.

## [1.19.0] — 2026-08-27

### Added

- **Theme families are declared once, with both light and dark variants
  together, and the app now paints them with the native CSS `light-dark()`
  function.** Every built-in theme used to be two independent `Theme`
  records in `BUILT_IN_THEMES` (`claude-light`/`claude-dark`, …) linked only
  by a cross-referencing `pairId`, with the light/dark toggle
  (`setActiveMode`) reapplying all ~28 CSS variables on every press because
  it conceptually switched from one `Theme` object to another. The five
  built-in families (HuginnDB, Claude, Neon, Summer, High Contrast) now each
  declare `{ light: ThemeColors, dark: ThemeColors }` once — `pairId` is
  gone — and `applyTheme` writes `--x: light-dark(hsl(…), hsl(…))` per
  variable instead of a single resolved value. The mode toggle
  (`applyColorScheme`) no longer touches a single colour variable: it only
  flips `color-scheme` (plus the Tailwind `.dark` class, still needed for
  the `dark:` variant used in a handful of components) and lets the browser
  pick the right half of each `light-dark()` — an O(1) toggle instead of
  reapplying the whole palette. `color-scheme` is always set to a single
  keyword (`light` or `dark`), never `"light dark"`, so it resolves to the
  user's manual choice rather than `prefers-color-scheme`.

  User-defined custom themes now declare both variants too, instead of being
  a single-mode exception — the Appearance editor gained an "editing:
  light | dark" toggle (independent from the app-wide mode toggle) to edit
  each variant of a custom theme separately, and duplicating/auto-forking a
  built-in clones both variants at once. `themeTransfer.ts`'s export format
  bumped to v2 (`{ name, light, dark }`); importing a pre-refactor v1 file
  (`{ name, mode, colors }`) still works — its single palette is duplicated
  into both variants as a starting point. Existing `localStorage` state and
  an `Environment`'s persisted/imported `theme_id` (a plain, backend-opaque
  string — Rust never interprets it) both migrate transparently through a
  small legacy-id table mapping the ten old ids to the five new family ids.

  Since `--x` moved from a raw `"H S% L%"` triple to a full `light-dark()`
  colour, every `hsl(var(--x))`/`hsl(var(--x) / N)` usage across the
  codebase (`tailwind.config.js`, `index.css`, and about twenty component
  files) was swept to `var(--x)`/`color-mix(in srgb, var(--x) N%,
  transparent)`. `tailwind.config.js`'s colour tokens specifically use
  Tailwind's `<alpha-value>` placeholder rather than a literal `color-mix()`
  wrapped around the modifier — Tailwind's own opacity-modifier parsing
  (`bg-brand/25`) does string-matching on `hsl(var(--x))` and doesn't
  recognise `var(--x)` or `light-dark(...)`, so every colour token needed
  that placeholder uniformly to keep `/NN` opacity modifiers working
  (an omission there fails silently — the modifier is dropped, not an error
  — rather than loudly).

- **An editor for the document a shared origin publishes.** A shared origin
  (#108) was strictly pull-only: `sync_origin` read the file and never wrote it,
  so publishing meant running "Export environments…", picking a destination in
  the native dialog and dropping the JSON on the share. Updating it meant
  repeating that export from whatever the publisher happened to have mounted at
  that moment — or editing the JSON by hand.

  That cost three things in practice. The publisher could only publish what was
  configured on their own machine right then. Any small change — renaming an
  environment, dropping one connection — meant a full re-export, which
  **re-encrypts every secret in the file** (`encrypt_secret` draws a fresh salt
  and nonce per call), invalidating the `landed_secrets` cache of every consumer
  and handing them tens of millions of PBKDF2 rounds on their next sync. And
  there was no way to see what a publish would do to the team before doing it —
  including the case that matters most, below.

  Settings → Shared origins → "Edit the document…" now opens a full-screen
  editor for the file: which connections it publishes and how each one's
  password travels, the environments and their membership, the JSON Schema slice
  and its bindings, and the publication metadata. Each pane offers what this
  machine already has as its left-hand side — the connection list, the schema
  library, and (via `list_publishable_environments`) this machine's own
  environments, resolved by the same `referenced_profile_ids` the export uses, so
  building a file from scratch is copying rather than retyping. Importing an
  environment brings the connections it references with it, since an environment
  whose membership names ids the document does not carry is a filter over
  nothing. A *mirrored* environment is excluded on purpose: its identity for a
  consumer is the publisher's `origin_source_id`, not the local
  `Environment::id` it would have to be published under, so copying one in would
  mint a second bundle for an environment the document may already carry. It is a **document** editor,
  not a view onto this machine: nothing in it reads from or writes to
  `profiles.json`, `tab_state.json` or `json_schemas.json`, and saving changes
  nothing locally. The file it builds is the same
  `transfer::EnvironmentExportFile` the export command already writes — one
  format, one constructor (`origin_doc::build_origin_file`), so the two can
  never drift.

  **A password that has not changed travels verbatim.** Every secret loaded from
  the file starts as a "keep" slot and is copied byte for byte, which is what
  makes renaming an environment cost the team exactly zero key derivations
  instead of 600 000 per slot per connection. Rotating the passphrase is the one
  operation that re-encrypts everything, and it is an explicit switch with the
  cost priced next to it.

  **The publish preview says what nobody else can.** It simulates a consumer's
  next sync by running the real `merge_into` against the file it is about to
  replace — added, genuinely changed, disappeared, plus the re-encryption bill
  and what a brand-new machine receives. The row that justifies the whole
  feature is the silent one: past `commands::origins`'s suspicion threshold a
  consumer's sync decides the read is broken and clears its own `vanished` list,
  so publishing a file missing half the roster used to leave every consumer with
  phantom connections and **no notice whatsoever**. There was no surface in the
  product where that was discoverable; now the confirmation dialog says it and
  suggests splitting the change in two.

- **Origins have a role, and it is one of three layers.** `Origin.role`
  (`consumer` by default, `#[serde(default)]`) records the *intention* — every
  origin registered before this, and every newly registered one, is a consumer,
  so nobody gains write access to a shared file by installing an update.
  Switching it is explicit, confirmed and reversible. The *authority* is the OS:
  `probe_origin_writable` creates and deletes a real file next to the document
  before the editor offers to save, because permission bits on a Windows share
  describe the local mount rather than what the server will accept — a
  read-only share opens the editor read-only rather than failing at the last
  step. `meta.maintainer` / `meta.revision` inside the file are the third layer
  and are *coordination only*: what actually stops two publishers clobbering
  each other is the content hash the save compares.

- **The registration itself is finally editable.** `update_origin` shipped in
  1.18 with zero call sites: an origin could be registered and removed but never
  renamed or repointed, so a moved share meant deleting the registration and
  re-adopting every connection it had published. Settings → Shared origins now
  has that form, with a file picker instead of a bare text field for the path,
  and a "New document…" action that creates an empty file on the share and
  registers it as one this machine publishes.

- **A shared origin now syncs the JSON Schemas its file carries.**
  `docs/JSON_SCHEMAS.md` said this was not wired up, and it was not — the
  plumbing (`origin_id` on both types, the bundle inside
  `EnvironmentExportFile`) existed but nothing read it on the pull. It does now,
  under the rules the connections already follow rather than the one-shot
  importer's: entries are matched by **id**, not by name, so a four-hourly poll
  refreshes in place instead of accumulating `cfg (2)`, `cfg (3)`, …; only
  entries the origin already owns are overwritten, so a schema you wrote is
  never touched and a published name that collides with yours steps aside; a
  binding naming a connection this machine does not have arrives **disabled**,
  keeping its pin; and nothing is deleted — a disappearance is reported, like a
  vanished connection's.

- **MongoDB index and collection DDL, reachable from the query editor and over
  MCP.** The report that started this was from a colleague's AI client, and it
  was accurate: the connector had no way to create an index, drop one, drop a
  collection or rename one — "neither through `run_query` nor as a separate
  tool". `drop_view` refuses a collection by design (a MongoDB view and a
  collection share one namespace, and a mistyped name must not delete
  documents), so there was no way round it either.

  **The gap was in the grammar, not in the connector.** The list of accepted
  operations is `build_op` in `db/mongo/shell.rs` — the parser the *desktop
  query editor* uses — so the editor could not create an index either. Widening
  it fixed both surfaces at once: `db.coll.createIndex({createdAt: -1})`,
  `dropIndex("name")`, `hideIndex`/`unhideIndex`, `drop()` and
  `renameCollection("clients")` all parse and run now. Each one delegates to
  the code that already owned its guards rather than issuing its own
  run-command, so the `_id_` refusal, the `createIndexes` name defaulting and
  the `dropTarget: false` pin apply unchanged — and `dropTarget: true` is
  refused by the parser, because otherwise the grammar would be the one way to
  make a rename silently delete whatever held the destination name.

  `renameCollection` is same-database only, matching what `mongosh` accepts. A
  cross-database move stays in the explorer's Rename dialog: a qualified
  `"otherDb.coll"` looks like the obvious spelling for it, but a collection name
  may legitimately contain dots (`system.views`, `logs.2024`), so that reading
  would turn a valid rename into a silent move.

  **Two MCP tools, MongoDB-only: `create_index` and `drop_index`.** Both at the
  `full` tier, which was forced rather than chosen — `createIndex` through
  `run_query` is classified DDL, so a `data`-tier tool would have handed back
  exactly what the statement path denies. There is deliberately nothing for the
  SQL drivers: an index there is created with `CREATE INDEX`, which `run_query`
  already reaches at `full` and which is strictly more expressive than any
  portable set of fields (`USING gin`, `INCLUDE`, a partial predicate). And
  nothing for replacing an index, because MongoDB cannot alter one in place —
  it is a drop plus a create, and two calls keep the window where the index is
  missing visible to the caller.

  **`list_indexes` had to grow with them.** Over MCP it reported the SQL-shaped
  `{name, columns, unique}`, so a model that read `["createdAt"]` and wrote it
  back would recreate the index *ascending* — invisible in testing, permanent
  in the data. Its bridge arm now answers from the rich reader on MongoDB and
  each entry carries a `mongo` object with the real definition: per-key
  direction and type, `sparse`, TTL, partial filter, collation, weights, size
  and usage. The explorer still calls the lossy reader, so the extra
  `$collStats`/`$indexStats` round trips are paid only on the MCP path.

  Index writes also emit a Console entry now, which they never did — the same
  `LogSink` seam that puts them in `mcp-audit.log`.

- **The keyboard-shortcut system, rebuilt.** It shipped in 1.10.0 as the
  smallest thing that could work — eight rebindable actions, one combo each,
  and 127 lines holding the catalogue, the key lexicon and the matcher
  together. What it could not express had accumulated: no secondary keys, no
  chord sequences, no notion of *where* a shortcut applies, no way to unbind
  anything, and no tests at all.

  **A binding is now a list.** `prefs.json` stores `["Mod+Enter", "F9"]` rather
  than one string: the first entry is the primary one (what menus, the palette
  and tooltips display), the rest are aliases that fire just as well. Three
  states stay distinct and all three mean something — a missing key is "use the
  default", `[]` is "I unbound this on purpose", and a non-empty list is
  primary plus aliases. `Preferences.keybindings` became
  `HashMap<String, Vec<String>>` behind a deserializer that also accepts the
  old bare string, so an existing `prefs.json` needs no migration and no
  version bump. (A downgrade to a build predating this cannot parse the list
  form, and since a bad `prefs.json` degrades to defaults, such a downgrade
  loses every preference rather than just the shortcuts. Documented at the
  deserializer.)

  **Chord sequences work**, VS Code style: `Mod+K` then `Mod+S`. Nothing ships
  as a sequence — they exist so there is somewhere to put the commands that no
  longer fit in one combo. A half-typed prefix waits two seconds and shows
  itself in the status bar, because a shortcut that silently swallows the next
  keystroke reads as a broken keyboard.

  **Actions now have a scope**, and it is resolved from the DOM: a surface
  declares `data-kb-scope` and the nearest one to the focused element decides
  what is audible, together with `global`. This is what lets `grid` and
  `editor` hold the same key without ambiguity, and it replaces the ad-hoc
  arrangements the four previous listeners had grown — `DataGrid`
  hand-filtering modified chords, `SideEditorPanel` calling
  `stopImmediatePropagation` to win a `Mod+S` race. One `createKeyDispatcher`
  now serves the window listener and Monaco's `onKeyDown` alike (the editor
  still needs its own redispatch — `addCommand` freezes a keybinding bitmask at
  registration and cannot re-check a live one).

  **The catalogue grew from 8 actions to 25, merged with the command
  palette's.** The palette already knew how to run sixteen commands and the
  menus another handful; none could be given a key, because the shortcut table
  was a separate list that happened to describe some of the same actions. Each
  new action reuses the label the palette or the menu already had, so there is
  one name per command rather than a second wording for the shortcut list. Most
  ship deliberately **unbound**: being in the catalogue is what makes an action
  searchable, bindable and conflict-checked, and spending a default key on it
  would take that key from whatever the user actually reaches for. Four get
  one: `Mod+T` (new query), `Mod+W` (close tab), `Mod+B` (schema panel) and
  `` Mod+` `` (console), plus `Mod+Shift+N` for a new window. The palette and
  the menus now read the live binding instead of restating it, so a rebind
  shows up in both without a reload.

  **Settings → Shortcuts was rebuilt** around the three questions a list of
  twenty-five is actually asked. *What fires this action* — each binding is its
  own chip, click to re-record, `×` to drop, `+` to add; reserved keys sit
  beside them dimmed. *What does this key do* — a "By key" chip turns the
  search box into a capture field and filters to whoever uses the combo you
  press. *What have I changed* — a "Modified" filter and a count, which is why
  "Reset all" now **clears** the overrides map instead of writing every default
  into it: an override equal to its default is not an override, and that filter
  would be lying. Recording moved into a dialog, where capture is *armed rather
  than permanent* — while armed it eats every key, so `Escape` and `Enter` are
  bindable; the moment a chord lands it disarms and those two go back to
  meaning Cancel and Save.

  **Conflicts stopped being a wall.** A clash is only reported when the two
  scopes can actually be heard together, so anything reported is a real
  ambiguity — and the dialog offers to take the key off the other action, in
  the same write, rather than just refusing. It now also sees the reserved
  bindings and the normalized spelling, both of which the old check was blind
  to: rebinding something onto `Mod+R` used to be accepted silently and then
  never fire.

  **Shortcuts export and import** as JSON, following `themeTransfer.ts`. Only
  your overrides travel, never the resolved bindings — exporting what each
  action currently does would bake this version's defaults into the file and
  opt the importing machine out of every default added since. An action the
  importing build does not recognise is named rather than dropped in silence.

  Two long-standing defects went with the rewrite. **Nothing checked where the
  focus was:** the old listener's only guard was `e.isComposing`, so binding an
  action to a bare letter made that letter untypeable across the app — now a
  chord indistinguishable from typing is suppressed inside a text field, while
  `F5`, `Escape` and the arrows keep working there. And **`Ctrl+Enter` was
  rebindable in only one of the three Monaco editors**; the view and pipeline
  editors used a fixed `addCommand`. Both now go through the redispatch.

  Also: `Ctrl` in a stored combo is renamed `Mod`, which is what it always
  meant (`ctrlKey || metaKey`) — the old name was a lie on macOS and left no
  way to bind the real Control key, which `Ctrl` and `Meta` now do as exact
  tokens. Stored combos migrate on read, so nothing is rewritten on disk.
  Documented in `docs/SHORTCUTS.md` (English and Spanish), and covered by 96
  frontend tests plus two Rust contract tests where there were none.

- **Settings → MCP is now a tree, with bulk write-policy buttons.** It gets the
  same All / Local / Shared filter and the same collapsible sections per origin
  as the connection manager, plus the group folders, so a server sits in the same
  place in both surfaces — with less on each row, since a snippet is built from
  ids and not endpoints. Below the list, one button per policy sets **every listed
  connection** at once (the scope filter and the search decide what "listed"
  means, and the count is on the button). "Full" asks first: it is the level that
  lets an AI client change schema.

  The buttons act on what is listed rather than on what is checked, because the
  checkboxes already answer a different question — which connections to expose —
  and one control cannot mean two things.

- **The connection manager now tells local connections apart from the ones a
  shared origin publishes.** A registered origin (#108) imports its connections
  next to your own, and until now nothing in the manager said which was which.
  Worse, the free-text group folders merged across the divide: a "Producción"
  folder you made and a "Producción" folder IT publishes appeared under one
  header. The rail now leads with an **All / Local / Shared** filter (with
  counts), which hides itself entirely if you have no origins registered. The
  Shared view splits into a collapsible section per origin, named after it and
  marked read-only, plus a trailing section for connections whose origin has
  since been unregistered. In the other two views a shared connection carries a
  small badge whose tooltip names the publishing origin.

  Settings → MCP gets the same sections. That is the point of the whole change:
  a connection published by an origin keeps the **same id on every machine**, so
  a connector snippet built from shared connections works for the whole team
  as-is, while one built from a stale local copy works only on your laptop —
  and picking ids out of a flat list gave you no way to tell them apart.

- **"Delete all local connections"**, in the connection list's overflow menu.
  The supported way to move a team onto a shared origin is to drop the local
  copies and keep only what the origin publishes; doing that one connection at a
  time was the only option before. It is disabled while a search is active: with
  a filter on, "all" is ambiguous, and guessing wrong deletes connections you
  never saw. Use the checkboxes for that case, where what will go is on screen.

- **Pinned ("frozen") columns in the data grid, Excel-style.** A small pin
  icon in each column header — visible on hover, always shown once pinned —
  toggles a column between scrolling normally and sticking to the left edge.
  Any number of columns can be pinned at once; they stack in the table's own
  left-to-right order, not the order they were pinned in, and the row-number
  / selection gutter is always pinned first as the anchor everything else
  counts its offset from. Persisted per table (like column widths), keyed the
  same way and skipped for ad-hoc query results, which pin in-session only.

  The header side was straightforward — each `<th>` already paints its own
  opaque background, so it just needed `position: sticky` and the right `left`
  offset. The body side needed a real fix, not just the same treatment: a
  row's background lives on its `<tr>`, and the translucent tints used for
  selection/multi-selection/zebra stripes (`bg-brand/30`, `bg-brand/10`,
  `bg-muted/30`) are translucent *on purpose* — a subtle wash over the page
  background is the intended look for an ordinary row. A `position: sticky`
  cell can't use that: once the browser promotes it to its own compositing
  layer, a translucent background lets whatever's scrolling underneath show
  straight through, so a pinned cell in a selected or zebra-striped row showed
  its own text superimposed on the next column's. Pinned/gutter cells now get
  a `color-mix()`-computed *solid* equivalent of the same tint via inline
  style, so they read identically to their non-pinned neighbours while
  actually hiding what scrolls behind them. The one accepted trade-off: a
  pinned cell doesn't pick up the row's hover tint, since that would need the
  same solid-color treatment to compete with a CSS `:hover` rule, which isn't
  worth the added complexity for a transient state.

### Changed

- **An environment's theme override now fixes only the theme *family*, never
  the light/dark mode.** Before the `light-dark()` refactor above, an
  environment's forced theme id (e.g. `claude-dark`) implied a mode as a side
  effect of which of the two linked `Theme` records it named — so switching
  into an environment with a forced theme could silently flip the user's
  current light/dark preference along with it. Family and mode are now
  independent axes in the theme store (`themeId` vs. the new global `mode`),
  and an environment override only ever resolves a family — the user's mode
  preference carries across environment switches unchanged. This is the
  intended behaviour going forward (an environment describes session/visual
  identity, not a personal ergonomic preference), not a regression.

- **`state_file::write_atomic` is extracted, and every origin-document write
  goes through it.** `save_atomic` only ever accepted a name relative to the
  config directory — by design, since gotcha #26's canary isolation depends on
  that being the only way in — so it could not express a path on a share. A
  plain `fs::write` there is exactly the truncated read
  `disappearance_is_trustworthy` exists to paper over: a publisher mid-save
  looks identical to an admin who deleted half the roster. The document is
  written to a temp file **in the destination's own directory** (a `rename` is
  only atomic within one filesystem, and a share is a different volume),
  `fsync`ed, then renamed, with the previous revision kept alongside as
  `<name>.json.bak`. The one-shot export commands are unchanged: they write to a
  destination the user just picked in a save dialog, which nobody else is
  reading concurrently.

- `ExportMetadata` gained optional `maintainer` / `revision` / `note`. All three
  are `skip_serializing_if`, so a plain "Export profiles…" or "Export
  environments…" file stays byte-identical to a pre-1.19 one — which is also
  what lets the editor rebuild a file it did not write itself byte for byte.

- **`ImportProgressBar` is now `common/ProgressBar`, with its caption as a
  prop.** It had exactly the shape the origin publish needed — a determinate bar,
  because the work is one 600 000-iteration PBKDF2 derivation per secret and a
  spinner is not enough feedback for a dozen of them — and a third call site
  outside `connection/` is precisely the criterion gotcha #28 sets for `common/`.
  Publishing feeds it from its own `huginndb://origin-publish-progress` event
  rather than reusing the import one: an event whose name says "import", emitted
  by a publish, is a wire contract that lies, and a window doing both at once
  could never tell them apart. Nothing is emitted when every envelope travels
  verbatim, which is the common case and the instant one.

- **The Schema panel's filter searches every open connection at once, and says
  where it is looking.** There was one filter box, and it silently applied only
  to whichever connection happened to be *selected* — every other one was
  handed an empty needle and stayed unfiltered. The only marker of "selected"
  is a 2px hairline on the row, and the selection moves on its own when you
  open a tab or pick a table from the command palette. So with two connections
  open you typed, one subtree filtered, the other did not, and nothing
  explained it. Reported by several users.

  Now every live connection is searched. Each connection row carries its own
  match count; one with nothing to show folds to a single dimmed line instead
  of quietly displaying its whole tree, and it is never hidden — that row is
  what you need in order to connect it or to narrow the search to it. The fold
  a search causes is visual and temporary: it is not written into the
  environment's remembered folds, so a search can no longer leave you with
  connections folded that you never folded. The needle is also dropped when you
  switch environments, which it used to survive.

  **Narrowing is still possible — it is just visible now.** "Search here only"
  on a connection or a database (its right-click menu, or the button that
  appears on a connection row while you are searching) puts a chip under the
  box naming what you narrowed to. Leave it with the chip's ✕, with Backspace
  on an empty box, or with Escape. This replaces a second invisible scope:
  expanding a database used to silently restrict the search to it *and*
  collapse the others.

- **Typing in that filter no longer opens database connections.** Every
  debounced keystroke used to open a connection pool for each database it had
  not read yet — bounded to three at a time since 1.13.0, which made it
  survivable rather than right. Searching now looks at what is already loaded,
  and reaching further is a button that says how many databases it will load.
  On a server shared with your application or your IDE, that is the difference
  between a search and a small burst of connections.

- **A `0` next to a connection now means the search really found nothing
  there.** The tree distinguishes "still loading", "never read" (`—`, or `N+`
  when part of a server has been read), "not in the current scope" and a real
  zero. A provisional zero is what makes you give up on a search that would
  have worked.

- **The Schema panel has a title again, and two fewer notice lines.** Its two
  tree-wide actions ("Disconnect all", "Connections to show") were labelled
  buttons that truncated to unreadable stumps at the widths this panel is
  normally dragged to; they are icons with tooltips in the new header, and the
  "showing N of M connections" line folds into a marker on the icon that
  changes it.

- **Three new shortcuts, under Settings → Shortcuts.** `Mod+Shift+F` opens the
  Schema panel if it is collapsed and focuses the filter; `Escape` inside the
  panel clears the search in layers (text, then scope, then focus); and
  "Search only the selected connection" ships unbound but is bindable and
  searchable in the command palette.

- **Disconnecting one connection reports that it is working, and "disconnect"
  has one icon everywhere.** The ✕ on a connection row (and in the status bar's
  connection list) was wrong twice over: an ✕ on a row reads as "remove this
  connection", which is a different and much worse action than closing its
  pool, and it gave no sign at all while a teardown that can take seconds was
  in progress. Both now show the same plug mark the "Disconnect all" button
  carries, with a spinner while they work. The right-click menu and the command
  palette used a third icon for the same command; they follow suit.

- **"Disconnect all" no longer makes you wait.** It closed the connections one
  after another, and a single disconnect is already several round trips —
  the backend closes each of a server's per-database pools in turn, waiting up
  to five seconds each on one that has stopped answering. So one unreachable
  server made every healthy one behind it wait out its timeout first. They now
  close at the same time, and the button shows that it is working. The same
  command from the keyboard shortcut or the command palette was a separate,
  faster implementation that left the tree stale and its tabs pointing at
  closed pools; both paths are now the same one.

- **Deleting connections now confirms in-app, and says what it takes with it.**
  There were two confirmations before: a bare OS `window.confirm` for a single
  connection and an in-app dialog for a multi-selection, and neither mentioned
  that a delete also removes the password from the OS credential store, the
  connection's tabs and "databases to show" filter **in every environment**, and
  any JSON Schema bindings pinned to its columns. One dialog now serves all three
  paths and lists exactly what applies to the connections you picked — a SQLite
  file has no stored password, an untunnelled connection has no SSH secret.

- **A connection a shared origin publishes can no longer be bulk-deleted.** It
  used to be selectable, and deleting it was worse than useless: the id travels
  in the published file, so the next sync recreated the connection identically —
  after your local password entry was gone. Its checkbox is now disabled, with a
  tooltip pointing at what actually works (removing the origin in Settings). The
  backend refuses those ids too, so the CLI and the MCP connector cannot route
  around it.

- **Bulk deletes are one operation instead of N.** Deleting forty connections
  used to rewrite `profiles.json` and `tab_state.json` forty times each and fire
  forty change events, which made every open window re-read and re-render forty
  times. It is now a single pass, and it reports what it skipped or could not
  clean up instead of silently swallowing it.

- The connection manager is wider (and its list 320px instead of 240px):
  the provenance filter put three segments above rows that already carry a name,
  a driver badge and an origin mark, and names were truncating mid-word.

### Fixed

- **Double-clicking a foreign-key cell needed a second, unrelated click before
  the combobox appeared.** `GridRow` is `React.memo`'d so a click only
  re-renders the rows it actually affects — every fast-changing bit of state
  that can change what a row shows gets narrowed to "does this concern THIS
  row" before it reaches the component, the same way `inlineEditHere` already
  worked. `fkEditCell` had no such prop: the `cell` renderer read it correctly
  through a live ref, but that only mattered once React actually re-rendered
  the row, and the second click of a double-click updates only `fkEditCell` —
  the first click had already set `activeCell`/`selectedRowIndex`/
  `selectedCell` — so no prop of that row's own changed and `React.memo`
  skipped it outright. The combobox only appeared once an unrelated click on
  another cell or row forced a re-render some other way. `GridRow` now takes
  an `fkEditHere` prop, narrowed the same way, purely to give `React.memo`
  something to compare.

- **The cell editor opened in JSON mode for almost any column, even plain
  text.** A JSON Schema binding (1.18's feature) was meant to force JSON mode
  when a column has one, so the user gets validation instead of a heuristic
  that only answers "json" when the text happens to parse. But `CellEditor`
  and `SideEditorPanel` decided that from the mere presence of a
  `CellBindingContext` — connection/schema/table/column coordinates — which is
  truthy for nearly any cell of a real table, bound or not. `CellEditorBody`
  already computed the right check a few lines below (whether a schema is
  actually *resolved* for that column, from `useJsonSchemas`'s cache) to
  decide whether to attach a schema to the Monaco model; the two callers above
  it now use that same check to decide the initial language, instead of the
  coordinates alone.

- **The cell "expand" button could be scrolled out of view on a wide
  column.** It sat at the end of the cell's flex row (`ml-auto`), so on a
  column resized wider than the visible scroll area the button was off-screen
  until the user scrolled that specific cell all the way over. Both places it
  renders — the read-only "selected cell" affordance and the inline
  `CellInput` editor — now make it `sticky` against the grid's own scroll
  container, the same technique already used for pinned columns, with an
  opaque background for the same reason: `sticky` promotes the button to its
  own compositing layer, and a translucent one would let the cell's text show
  through while scrolling.

- **A wide active cell's content painted over the pinned gutter column while
  scrolling, instead of disappearing behind it.** The keyboard-active cell's
  `<td>` unconditionally got `z-10` for its ring, which beat a pinned
  column's `z-[1]` even when they were two entirely different cells — so
  scrolling a wide active cell horizontally slid its text and background
  right over the top of the sticky row-number column instead of being hidden
  behind it, the one thing `position: sticky` on a pinned column is supposed
  to guarantee. A plain `position: relative` (no z-index) already paints
  above *unpositioned* neighbours regardless of z-index, which is all the
  ring ever needed there; `z-10` is now scoped to the one case that actually
  has to beat a pinned column's own z-index — the active cell being pinned
  itself, so its ring stays visible over its own solid background.

- **A multi-database connection with a "databases to show" subset could show an
  empty tree while searching, with no explanation.** The check for "are we
  still loading databases?" walked every database on the server while the loop
  that actually loaded them applied the subset — so with a subset active it
  never finished, and the "no tables match the filter" line could never appear.

- **Databases loaded by searching are remembered again.** The filter's own
  prefetch opened them through the untracked path, so a tab opened against a
  database you had reached by searching (rather than by expanding it) was never
  restored — not on reconnect, not across an environment switch, not across a
  restart.

- **The tree no longer filters its contents by a different needle than the one
  that chose what to show.** Each multi-database explorer debounced separately
  while the inner subtree was handed the raw, undebounced needle, so for a
  quarter of a second after every keystroke the two disagreed.

- **Ctrl+V now works on `BIT` cells in the data grid.** It used to be a
  deliberate no-op (issue #79): pasted text was routed into `inlineEdit`,
  which a `BIT` column renders as `BitInput` — a fixed `<select>` with no
  free-text control to receive it. Paste on a `BIT` cell now normalizes the
  clipboard text the same way `BitInput` itself does (`"1"`/`"true"` → `"1"`,
  `"0"`/`"false"` → `"0"`, anything else non-empty → `"1"`, empty → `NULL`)
  and commits it directly, skipping the round trip if nothing would change —
  the same pattern the FK combobox and `BitInput`'s own `onSelect` already
  use. No backend change was needed: `update_cell` already resolves the MySQL
  `BIT` `CAST` from the column's catalog type, not from the value it's handed.

- **A MongoDB connection set to `read-only` could not be read over MCP while the
  desktop app was sharing its pools.** `run_query` decided which classifier to
  use by looking the connection up in the *connector's own* pool map — and that
  map is empty by design whenever the app owns the pool (pool sharing, 1.13.0).
  So every bridged MongoDB statement fell through to the SQL keyword heuristic,
  where `db.users.find({})` matches none of
  `select`/`with`/`show`/`explain`/`pragma` and therefore came back as a write.
  A plain `find` was refused at `read-only` and only worked from `data` upward.
  The app's own independent re-check agreed, for the same wrong reason.

  Both now call one classifier, `db::classify::classify_statement`, which picks
  the grammar from the statement *text* — the one input both enforcement points
  always have, and pure enough to test without a server. While the mongosh
  grammar had no DDL this bug was merely too strict; it would have become a
  privilege escalation the moment `db.coll.drop()` existed, since both sides
  would have tiered it `data`. Tests now pin every operation's tier on both
  layers.

- **`updateMany({})` and `deleteMany({})` over MCP are refused, like their SQL
  equivalents.** The whole-relation guard exempted MongoDB, so a `data`
  connection could empty a collection in one call while `DELETE FROM users`
  was refused at every tier — the same blast radius, opposite answers. The
  opt-in mirrors SQL's `WHERE 1=1`: a predicate that is trivially true, e.g.
  `deleteMany({_id: {$exists: true}})`. `drop()` is not covered, deliberately —
  its scope is unambiguous and it already sits behind `full`, exactly like
  `DROP TABLE`.

- **A shared connection's MCP write policy no longer reverts on the next sync.**
  The policy is a local decision about what an AI client may do on *this*
  machine, which the publisher of a shared origin cannot know, but a sync
  replaced the whole record and took it with it. Setting a shared connection to
  "data" therefore worked until the next pull and then silently went back to
  read-only — which made the MCP panel unusable for anyone whose connections all
  come from an origin. Everything else on a published profile is still the
  file's to dictate.

- **Renaming a shared origin now reaches the rest of the app.** The origin
  registry was read once, locally, by the Settings panel that owns it, so nothing
  else could name the origin behind a connection — and "Sync now" never refreshed
  its own "last synced" timestamp, which stayed stale until the panel was
  reopened. It is now cached in one place and invalidated by a backend event, so
  every window sees a rename or a sync immediately.

## [1.18.0] — 2026-08-24

### Added

- **The documentation viewer now has sections.** A guide used to be one long
  scroll pane, which made the longer ones effectively unsearchable: `docs/MCP.md`
  is 400+ lines in a 70vh pane, so finding what a tool requires meant scrolling
  blind past five client configurations to reach the Security section. Each guide
  now opens on a **cover** — its introductory prose plus a card per section — and
  the sidebar is a tree: the guides, with the open one expanded into its
  sections, and a section expanded into its subsections. Picking one shows that
  section alone.

  The navigation is derived from the markdown headings, not from a list kept
  alongside them, which has two consequences worth stating. Adding a `##` to a
  guide adds it to the sidebar with no code change. And the sidebar translates
  itself: the Spanish body carries Spanish headings, so choosing the language
  chooses the labels too.

  In-document links work now. A `#anchor` jumps to its heading — switching page
  first when the heading lives on another one — and a relative link to another
  bundled guide switches to it. Both used to render in brand colour, underline
  on hover, and do nothing at all when clicked; there were eight anchors and five
  cross-guide links in that state. One outside the bundled set (a roadmap,
  `SECURITY.md`) now opens on GitHub rather than being a dead end. A test asserts
  that every anchor in every shipped guide, in both languages, resolves to a real
  heading, so renaming one out from under its inbound links fails the build
  rather than going unnoticed.

  Also fixed while in here: switching guides kept the previous scroll offset, so
  jumping from deep inside a long guide to a short one landed you at its end.

- **Views over the MCP connector: read, edit and delete.** Views were nearly
  invisible to an AI client. `list_tables` reported `kind: "view"` and
  `describe_table` returned a view's columns, but nothing could read a view's
  *body*, and nothing could create, redefine or drop one — the only recourse was
  hand-writing a catalog query per engine through `run_query`, and on MongoDB
  not even that, since its `mongosh` parser has no DDL vocabulary at all and a
  stored pipeline was unreachable in both directions.

  Two new tools, and one existing tool widened, on all five drivers:
  - `describe_table` now adds a `view` object when the relation is a view —
    `query` (the bare SELECT body) on SQL, `viewOn` plus the `pipeline` as
    source text on MongoDB. No new tool for reading: `describe_table` was
    already view-aware for the columns half, so the body belongs there.
  - `save_view` *(write)* creates, redefines or renames a view. It takes only
    `name` and `query` and reads the current definition itself to decide which
    of the three it is, and how to express it on this engine — Postgres `CREATE
    OR REPLACE`, MySQL `RENAME TABLE`, SQLite drop-and-recreate, MongoDB
    `createView`/`collMod`. `preview: true` returns the exact statements without
    running them.
  - `drop_view` *(write)* drops one, and refuses anything that is not a view.

  **The permission model is unchanged** — no new axis, no new setting. Both
  write tools are DDL, so both need the connection's existing write policy at
  `full`. That is the only consistent answer rather than a preference: the
  `CREATE OR REPLACE VIEW` you could write by hand through `run_query` is
  already classified as DDL, so a `data` connection is refused it, and a tool
  that allowed the same change anyway would hand back exactly what the policy
  just denied. It does leave one asymmetry worth knowing: dropping a *view*
  needs `full` while deleting *rows* needs only `data` — the same asymmetry
  `DROP TABLE` and `DELETE FROM` already have. `save_view`'s `preview` is a real
  exception rather than a loophole: it executes nothing, so it is classified as a
  read and works at any level.

  MongoDB rides the same two tools rather than getting its own pair. An AI
  client cannot see the difference from `list_tables` output, and one tool per
  verb is what it wants; the pipeline crosses as source text and is parsed only
  by the one parser the product has, so an `ObjectId(...)` in a `$match` still
  round-trips as a constructor rather than degrading to a string.

  SQL Server gained the ability to read a view's definition along the way; only
  *creating* one there is still unsupported. See [`docs/MCP.md`](docs/MCP.md).

- **A notification system of the app's own, replacing the library defaults.**
  Notifications were the toast library mounted with its stock configuration:
  four seconds, bottom-right, a hardcoded white/black card that `index.css`
  tried to recolour from the outside with ~60 lines of `!important`, and a
  check mark painted in the brand blue so a confirmation looked exactly like
  an affordance. Every visual decision now belongs to `NotificationCard`,
  raised through the new `lib/notify` façade — the library is kept purely as
  transport (stacking, the six positions, swipe-to-dismiss, timers, focus),
  and since a `jsx` toast is flagged `data-styled="false"` it no longer paints
  anything, so the entire `!important` block is gone rather than extended.
  The card is a theme surface: `popover` over `border` at the 10px radius, a
  3px semantic rail at one weight for every kind (colour is the only
  variable), a 28px icon medallion, the `2xs`/`3xs` type scale, the
  `elevation-*` shadow ramp, and a 2px hairline that drains for the remaining
  lifetime and freezes while the pointer is anywhere in the stack. `success`
  finally uses `--success` instead of `--brand`, and `info` is the one kind
  that spends the brand blue.

- **Clicking a file name in an export notification opens the file manager with
  the file selected.** The path used to be interpolated into the translated
  sentence (`"Exported to {{path}}"`), which made it unselectable, uncopyable
  and unopenable — the one thing anyone wants from it. A new `file` kind
  separates the title from the path, renders the base name as a real control
  (`api.revealItemInDir`, over the `opener` plugin's `reveal_item_in_dir`,
  newly permitted in `capabilities/default.json`) and offers "Open folder" and
  "Copy path" alongside it, with the containing directory beneath. Every
  export inherits it: table, filtered rows, collection, database, connection
  profiles, environments, JSON Schemas and themes. A file that has since been
  moved or deleted degrades to a struck-through name and a warning instead of
  a button that silently does nothing.

- **Repeats collapse into one notification with a counter.** A multi-row save
  used to stack seven identical cards; identical notifications raised within
  five seconds of each other now fold into one, counted, and the grouping
  policy lives in one place so the card on screen and the row in the history
  can never disagree about what happened.

- **A notification history behind a bell in the toolbar.** The same card,
  compressed to a row, grouped by day, with unread counting and every `file`
  entry still clickable — so an export from twenty minutes ago is one click
  from the file manager. In memory and per window on purpose: it is session
  ephemera, so it earns neither a state file nor a place in `prefs.json`
  (rewritten on every `Ctrl`+wheel of the grid), and a second window claiming
  the main window's notifications would be claiming work it never did.

- **Settings → Notifications**, a new section: position as a grid of six
  miniature windows rather than a dropdown (the choice is spatial), duration
  as presets plus the raw millisecond value, whether errors wait to be
  dismissed, how many are visible at once, expand-on-hover, card density,
  the history cap, and whether the bell is shown. Each row is addressable
  from the command palette, and the section's preview fires a *real*
  notification — judging six seconds against four is exactly what a drawing
  of one cannot help with.

- **A `progress` notification, handed a long-running import that outlives the
  dialog it started in.** `ImportProfilesDialog`/`ImportEnvironmentDialog`
  already show their own determinate bar (`ImportProgressBar`) while open —
  that stays the right surface, so nothing changed there. The gap was that
  neither dialog's close button, Escape, nor an outside click is disabled
  while an import is running, so closing one mid-decrypt used to leave the
  backend grinding through PBKDF2 in total silence: `useImportWizard`'s
  `handleClose` resets the wizard's own state immediately, and by the time
  the promise actually settled there was nothing left on screen to update.
  `notify.progress(title)` now hands that in-flight import off to a card the
  moment the dialog closes out from under it — a spinner or determinate bar
  (`done`/`total`, no close button, not swipe-dismissible) that morphs in
  place into success/error once the backend actually finishes, recorded in
  history only then, never as an eternal "Importing…". No cancel button: the
  backend has no way to actually cancel one.

  The event behind it (`huginndb://import-progress`) was also a global
  `emit`, so a second ("New window") import would have shown its progress in
  every open window; both `import_profiles` and `import_environment` now
  `emit_to` the window that started them, and the frontend bridge scopes its
  `listen` to match (CLAUDE.md gotcha #25's pattern, applied here for the
  first time outside `log_bus`).

- **A live notification stack that protects what actually matters.** Two
  gaps between the notifications rework above and Sonner's own stacking:
  past `visibleToasts`, Sonner just stops rendering the overflow with no
  indication anything is behind the fold — despite `maxVisible`'s own doc
  comment promising "the rest collapse behind a counter" — and it evicts
  whatever is oldest by arrival order, with no notion that an unread error
  (or a live progress bar) is worth more than a confirmation that already
  did its job. A small ordered mirror of the on-screen stack now backs both:
  a "+N notifications more" pill (`NotificationOverflowPill`, mounted beside
  every `<Toaster>`) for the first, and — before a new card would push the
  last visible slot behind the fold — dismissing the oldest *unprotected*
  card in front of it instead, so an error or a running progress bar never
  gets shouldered out of view, for the second.

- **"Export database…" closes the moment you click Export, and a
  `notify.progress()` card with a real row count takes over from there.**
  The dialog used to disable the button and relabel it "Exportando…" for the
  whole export, blocking the dialog rather than letting the user get back to
  work — and if they closed it anyway (Cancel/Escape/an outside click, none
  of which were guarded), the file kept writing in total silence, since
  `run()`'s task isn't tied to the dialog's lifecycle. `export_databases`
  (`dump.rs`) now runs a `SELECT COUNT(*)` pass over every selected table
  before writing anything, giving the notification a real `done`/`total` in
  rows — not tables, since one three-row table and one three-million-row one
  would make table-level progress worse than useless — emitted via a new
  `huginndb://export-progress` event (`emit_to` the originating window, same
  as `IMPORT_PROGRESS_EVENT`) as each table finishes. `export_sqlite` was
  also unified onto the same `&[TableInfo]` shape `export_pg`/`export_mysql`
  already took, dropping its separate `Option<&[String]>` filter path.

### Fixed

- **The SQL Server schema explorer never actually loaded a table's columns —
  it sat on the loading skeleton forever, with no error, on every table, on
  every server.** The connect-timeout fix above (still correct, still worth
  keeping) turned out not to be what most people were hitting: this one is a
  separate, more fundamental bug in the same driver, and it explains the
  "SQL Server just doesn't load the schema" reports on connections that were
  otherwise working fine — browsing table data, running queries, everything
  else worked; only the tree's column list never came back.

  `tiberius::Row::get::<T, _>` is `self.try_get(idx).unwrap()` — it *panics*
  when the column's actual `ColumnData` variant doesn't match what `T`'s
  `FromSql` accepts, rather than returning `None`. `db::mssql::schema`'s `i()`
  helper (used to read a catalog integer column of unknown width) tried
  `i64` → `i32` → `i16` → `u8` via `.get(...).or_else(...)`, which reads as
  graceful widening but is not: the very first mismatched attempt panics
  before the `or_else` chain ever runs. `sys.columns.max_length` is a
  `smallint`, so `raw_columns` (which every `list_columns`/`table_structure`
  call goes through) panicked on `i(r, "max_length")` for the first column of
  the first table, every single time — an `i64` read can never succeed
  against a `ColumnData::I16`. `list_tables` was unaffected only because its
  own use of `i()` (row/byte stats) happens to be genuinely `bigint`, which is
  why the table list itself always loaded fine. `list_users`'s `auth_type`
  (`sys.database_principals.authentication_type`, a `tinyint`) had the same
  latent panic, breaking the Security panel's user list for the same reason.

  A panic inside a Tauri command's async task never reaches the frontend as a
  rejected promise — the JS side's `invoke()` call is simply left pending,
  which is indistinguishable from a hang and is exactly why this looked like
  a timeout problem rather than a crash. It also explains why nothing in the
  existing test suite caught it: `i()`'s logic error only manifests against
  a real decoded `tiberius::Row`, which nothing in the unit tests constructs
  (`Row`'s fields are private to the `tiberius` crate).

  `i()` now uses `try_get` and discards the `Err` from a width mismatch
  (`.ok().flatten()`) instead of letting it panic, so the fallback chain
  actually falls through as originally intended.

- **SQL Server was the one driver whose schema explorer could get stuck on
  the loading skeleton forever, with no error and no way to retry.** Every
  `sqlx`-backed driver (Postgres/MySQL/SQLite) gets a connect-level timeout
  for free: `db::pool::tuned()` sets `.acquire_timeout(ACQUIRE_TIMEOUT)` on
  their `PoolOptions`, so even an eager `connect()` against an unreachable
  host fails after 30s. `tiberius` has no equivalent setting, and `db::mssql`'s
  own `connect()` never added one: neither the plain TCP connect nor the SQL
  Browser's UDP round trip (`Reach::Browser`, used for named instances) has
  any OS-level timeout of its own, so a host that silently drops packets — a
  firewall, or a stopped Browser with no reachable fallback port configured —
  hung the connect attempt indefinitely.

  That gap was invisible for ordinary queries, which run inside
  `commands::schema`'s `with_timeout` wrapper (`OPERATION_TIMEOUT`, 20s). It
  was not invisible for a **per-database view**: the multi-database explorer
  opens one lazily, via `commands::connection::ensure_database_view`, and
  every schema command (`list_databases`/`list_tables`/`list_columns`/
  `list_indexes`) calls that *before* it ever enters its own `with_timeout`
  block. So the first time a database was expanded in the tree — or the first
  query after the pool reaper had closed an idle session — SQL Server could
  hang the whole command with no bound at all, while every other driver's
  equivalent connect attempt already had one via `acquire_timeout`.

  `db::mssql::connect` now routes through a small `bound_by_acquire_timeout`
  wrapper using the same `ACQUIRE_TIMEOUT` the `sqlx` pools use, turning a
  hung connect into a clear `OperationTimedOut` error instead of a permanent
  skeleton. This covers both the per-database view's first connect and any
  later reconnect after the idle reaper closes a session — every path that
  opens a fresh TDS session goes through `MsSqlPool::acquire`, and that is the
  one place `connect` is called from.

- **Clicking a file name in any `file` notification always said "the file is
  no longer there," even for a file sitting right where it said it was.**
  `api.revealItemInDir` invoked `plugin:opener|reveal_item_in_dir` with
  `{ path }`, but the command's actual Rust argument is `paths: Vec<PathBuf>`
  (plural — it can reveal several items at once). The name mismatch failed
  Tauri's IPC deserialization on every single call, independent of whether the
  path existed; `NotificationCard`'s `reveal()` caught that as a generic
  rejection and reported it exactly like a moved-or-deleted file. Every export
  notification went through this — table, rows, database, connection profiles,
  environments, JSON Schemas, themes — so the "Open folder" affordance had
  been silently broken since the notification rework landed it. Fixed by
  sending `{ paths: [path] }`, matching the command's real shape.

- **Dropping a MongoDB "view" whose name is actually a collection deleted all
  of its documents.** MongoDB keeps views and collections in one namespace, and
  dropping either is the same `drop` call — so `db::mongo::aggregation::
  drop_view` was an unguarded `collection(name).drop()`, and pointing it at a
  real collection destroyed every document in it while reporting success. It
  was survivable in practice because the only caller was the schema explorer,
  where the user had clicked a row the tree already knew was a view. It stops
  being survivable the moment a caller can pass a name it merely guessed, which
  is what exposing view management over the MCP connector amounts to — so the
  guard lands ahead of that work rather than alongside it.

  `view_presence` now resolves a name to one of three states — absent, a
  collection, or a view with its definition already parsed — in a single
  `listCollections` round trip, and `drop_view` refuses anything but the third.
  The type check itself (`spec_is_view`) is a pure function so it can be tested
  without a server; it treats a spec with no `type` field as a *collection*,
  since that field only appeared in MongoDB 3.4 and an unrecognised reply must
  fall to the safe answer rather than the destructive one. `read_view` is now
  expressed in terms of the same helper instead of repeating the check.

  An absent name is now an error rather than MongoDB's silent idempotent
  success. That makes the driver consistent with the other four, all of which
  build a bare `DROP VIEW` with no `IF EXISTS`, and it means a mistyped name
  says so instead of reporting that it worked.

- **Creating a MongoDB index with a blank "Name" field always failed.** The
  dialog's "leave blank to let the server derive it" behaviour never worked:
  `NewMongoIndexSpec::to_document` simply omitted the `name` key when blank,
  but the raw `createIndexes` run-command this app uses (deliberately, over
  the typed `Collection::create_index()` helper) does not auto-derive a name
  the way that typed helper does, so the server rejected the spec with
  `FailedToParse: The 'name' field is a required property`. The write path
  now shares the same `field_1_other_-1` naming convention the read path
  (`spec_to_info`) already used for display, via a new `default_index_name`
  helper, so a blank name always resolves to a real one before the spec is
  sent.

- **A bulk/mass update ("Actualizar filas que coincidan") on a MySQL `BIT`
  column failed with `1406 (22001): Data too long for column`.** Single-cell
  edits and inserts already cast a MySQL `BIT` write through
  `CAST(? AS UNSIGNED)` (and a SQL Server binary column through
  `CONVERT(varbinary(max), ?, 1)`) because a plain textual placeholder is
  bound as the literal's ASCII bytes rather than coerced to the column's
  numeric/binary type — but the bulk-update SET-clause builder had its own,
  separate code path that never got this treatment and bound every assigned
  column as plain text regardless of type. `build_update_statement` now
  applies the same per-column casting (plus the catalog fallback for a stale
  schema cache) that `update_cell`/`insert_row` already have, shared by both
  the preview and the actual apply.

- **The query tab against a MongoDB connection was titled `query.sql` and
  seeded with a `-- ...` SQL comment**, even though MongoDB's query tab runs a
  bounded `mongosh`-style command (`db.<collection>.<method>(...)`), not SQL —
  which repeatedly confused people into treating it as a SQL surface. A new
  query tab against MongoDB is now titled `query` and seeded with a
  `//`-style comment matching the actual grammar (both driver-aware, via
  `resolveConnectionDriver`); the session-restore fallback title and the
  editor's bottom-bar language label follow the same rule. The tab still
  runs the same `mongosh`-style executor and keeps the Monaco `sql` language
  mode (and its already-Mongo-aware autocomplete/CodeLens) — only the naming
  changed, not the editing surface.

- **A shared origin carrying encrypted secrets stored the wrong thing in the OS
  keychain.** `sync_origin` wrote the base64 AES-256-GCM *envelope* as if it were
  the password, so every profile imported from such an origin failed to connect
  with an authentication error from the driver — and the real password was never
  recoverable from it. The decrypt path is now shared with the profile importer
  (`transfer::land_secrets`), which never stores a secret it could not decrypt;
  an origin whose passphrase is not available simply leaves the profile asking
  for a password, which is the documented behaviour (the passphrase travels
  out-of-band). Three regression tests cover it without touching a keychain.

- **Removed an unreachable IPC command that could read any keychain entry.**
  `load_password(account)` was registered but called from nowhere in the app; it
  took an arbitrary account name and returned the stored secret. Nothing in
  HuginnDB needs that shape — the connect path resolves its own key — so the
  command and its module are gone rather than narrowed.

- **The theme colour editor was rendered entirely in English**, whatever the
  selected language: the 26 colour names and 4 group titles were hardcoded
  strings in `lib/themes.ts`. They are i18n keys now, in both locales.

- **Numbers and dates followed the operating system's locale instead of the
  language chosen in Settings.** Twelve `toLocaleString()` calls had no locale
  argument, so a Spanish UI on an English system showed `1,234` and
  `8/21/2026`. They now go through `formatNumber` / `formatDateTime` /
  `formatTime`, which read `ui.language`.

- **Importing an environment hid its own connections when a conflicting profile
  was resolved as "Skip".** The skipped profile was absent from the
  original-id → new-id map, so the new environment's `visible_connections`
  filter dropped it, and any JSON Schema binding pointing at it was disabled
  even though the connection existed locally all along. A skipped profile now
  maps to itself.

- **Every launch froze the window for as long as the shared-origin sync took —
  a multi-second "Not Responding" on a real profile set.** Two causes, both
  fixed. `sync_origin` was a *synchronous* Tauri command, so it ran on the
  main thread: the one pumping the window, and the one that also had to read
  the export off a network share. And it re-landed **every** published secret
  into the keychain on **every** sync, whether or not anything had changed —
  at ~600 000 PBKDF2 rounds per slot. An origin publishing thirty tunnelled
  connections therefore spent tens of millions of SHA-256 rounds on the UI
  thread at every start, and again every four hours.

  The command is now `async` with its body on `spawn_blocking`, and each
  profile's ciphertext is fingerprinted so an unchanged secret is recognised
  and skipped. The skip needs both halves to be safe: the fingerprint alone
  would leave a keychain entry someone deleted missing forever, and the
  "is it still there?" check alone would never notice a rotated password. On
  the profile set this was found with (29 origin-owned connections, 26 of them
  tunnelled), a second launch went from a pegged core and a frozen window to
  0% and a responsive one.

- **A failing `accept()` on the MCP bridge could spin a core indefinitely.**
  The listener's loop retried unconditionally on the stated grounds that "a
  failed accept is transient", and dropped the error without logging it. That
  holds for a client that vanished mid-handshake, but not for descriptor
  exhaustion (`EMFILE`/`ENFILE`) — the textbook reason `accept()` fails
  repeatedly, and one that cannot clear until something unrelated closes a
  handle. The retries now ramp to a one-second cap after a few immediate ones,
  so the transient case is unchanged and a persistent one costs nothing, and
  the failure is reported to the Console instead of vanishing. Latent, not
  observed in the wild — found while diagnosing the launch freeze above.

- **A SQL document was split into statements incorrectly from its first string
  literal onward.** The splitter behind the editor's per-statement "▶ Run"
  CodeLens closed a quoted string and then, in the same pass, re-opened it on
  the same closing character — so everything after `'…'`, `"…"` or `` `…` ``
  was treated as one unterminated string and no later `;` was a boundary. A
  two-statement script showed one lens covering both, and importing a `.sql`
  dump (which goes through the same splitter before `execute_batch`) sent the
  whole file as a single statement, which the prepared protocol rejects.
  Dollar-quoted bodies and comments were never affected — only the three quote
  characters were missing the `continue` the other contexts already had.

- **A stray `;` counted as a statement.** `;;SELECT 1;` produced three, two of
  which the CodeLens offered to run, despite the splitter documenting that
  empty statements are skipped — a lone semicolon is not whitespace, so
  trimming did not catch it.

- **Importing a third profile with the same name numbered it `(3)`, skipping
  `(2)`.** The profile importer's rename ladder reused one counter for both
  rungs, so the sequence ran `name`, `name (imported)`, `name (3)`, `name (4)`,
  … It now matches the JSON Schema importer's — `name (2)` after
  `name (imported)` — because both call the same function.

- **Environment-import conflicts default to "Skip" rather than "Rename"**,
  matching the profile importer. Re-importing your own export accumulated
  `name (imported)`, `name (2)`, … on every round trip; the conflicts step is
  still shown, so a genuinely different environment is one click from Rename or
  Overwrite.

- **"Copy as ▸ SELECT" did not escape delimiters embedded in a table or column
  name**, producing a snippet that would not parse. It now goes through the same
  quoting the other clipboard formats use.

- **`profiles.json` was the only state file written without a temp-file +
  rename**, so a crash mid-write could leave every saved connection truncated —
  along with the keychain entries, JSON Schema bindings and origin links keyed
  on those profile ids. Every JSON state file now goes through one atomic writer
  (`src-tauri/src/state_file.rs`).

- **Three `match` arms that would silently mis-handle a future driver or filter
  operator.** `empty_table` fell through to Postgres's `TRUNCATE` for anything
  unlisted (so SQL Server would have run a statement it accepts with different
  semantics, and MongoDB a statement it does not have), and the SQL filter
  builder's comparison and `LIKE` arms fell through to `<=` and `EndsWith`. All
  three now spell out every variant, so adding one is a build error.

### Changed

- **Notifications last 6 s instead of 4 s, and errors wait to be dismissed.**
  Four seconds was the library's default and was never enough to read a file
  path or a driver message; kinds that carry something to act on now get a
  multiple of the configured duration (a warning twice, a file notification
  four times, capped at 30 s), and an error stays until it is closed — it
  usually carries something to copy, retry or report. Both are preferences,
  and an error also gets a "Copy error" action for free.

- **Internal: a project-wide pass over duplicated logic and misplaced
  responsibilities.** No behaviour change beyond the fixes above. The parts worth
  knowing about:
  - `db/exec.rs` — the execution counterpart to `db::sql::Dialect`. Twelve sites
    repeated the same `match pool { … }`, two of them byte-identical, one a
    re-inlining of a decoder that already existed 200 lines above it.
  - Postgres/MySQL/SQLite catalog introspection moved out of
    `commands/schema.rs` (1559 → 769 lines) into `db/{postgres,mysql,sqlite}/`,
    mirroring `db/mssql` and `db/mongo`. All 17 `unreachable!()` are gone.
  - `state_file.rs`, `AppState::pool_for`/`mongo_for`, `Dialect::quote_ident` and
    `Dialect::truncate_stmt` replace between 9 and 10 hand-rolled copies each.
  - `tab_state::mutate` replaces fourteen hand-written "take the write lock,
    mutate, clone the whole blob, drop the guard, save" bodies across
    `commands/{prefs,origins,connection}.rs`. The clone-and-release is not
    incidental: the save does file I/O, so holding the lock across it would
    block every other window's reader for the length of a disk write.
  - `commands::ensure_view` / `commands::entry_sink` replace the seven-line
    `ensure_database_view` prologue that opened forty-five connection-scoped
    commands across nine modules, eight of which also built the Console log
    sink by hand. Omitting it is invisible until a database view has been idle
    long enough for the reaper to close it, so making it one line is worth more
    than the 240 lines it removes.
  - `log_bus::log_sql_sink` is the one place a SQL Console entry is built.
    `commands::bulk` and `db::mongo::query` each rebuilt the same six-field
    builder chain by hand, twice — once per arm of an `Ok`/`Err` match — while
    `commands::query` documented itself as the single logging path. The helper
    moved down next to `LogEntry`, which is what lets the `db` layer use it
    without depending upward on `commands`.
  - `TableQuery` / `TableScan` / `TableFilter` replace the nine loose
    parameters the table browser threaded through `fetch_table_data`,
    `count_table_rows`, `export_table_rows`, their `_inner` cores and four
    MongoDB entry points. Six of the fourteen `#[allow(too_many_arguments)]`
    are gone with them. The IPC payload is unchanged on the wire (the
    predicate is `#[serde(flatten)]`ed), and four deserialisation tests now pin
    the exact JSON the grid sends — a field that exists on one side of that
    boundary and not the other is dropped in silence.
  - Four more driver-level primitives that had been copied instead of shared:
    `db::values::hex` (three byte-identical private copies, each with a comment
    saying so), `db::exec::ping` (the keepalive heartbeat and the connect probe
    each enumerated all five drivers), `db::mysql::{is_bit_type, bit_cast,
    normalize_bit_value}` (the `BIT`-write reasoning of gotcha #15, spelled out
    at six sites), and `Dialect::rename_stmt` (`rename_table` and `rename_view`
    differed only in Postgres's keyword and one word of an error message).
  - The import/export plumbing: `transfer::{check_meta, metadata, save_export,
    disambiguate_name}` replace the same four steps written out once per
    transfer kind (profiles, environments, JSON Schemas), and
    `resolve_ssh_secret` is shared with the MCP connector instead of repeated
    there.
  - The MCP connector's eight read-only tools share one `read_tool` body
    (reopen a reaped pool, resolve the MongoDB per-database target, one bridge
    request, serialise). The write tools keep their own — their policy check
    sits between two of those steps, and the double check across the two layers
    is deliberate. `resolve_mongo_target` also stops making a bridge round trip
    to answer "is this MongoDB?" for the four tools that pass no schema and
    ignore the answer.
  - `QueryResult::{rows, affected, with_total, with_truncated, with_row_types}`
    replace nine struct literals that each restated the same seven fields, and
    `src-tauri/src/testkit.rs` holds the `ConnectionProfile` fixture six test
    modules had a private copy of — so a new field on either is one edit rather
    than nine or six.
  - Frontend: `useImportWizard` (three dialogs), `useAsyncSubmit` (ten),
    `OverlayPalette` + `useListNavigation` (the command palette and the tab
    switcher), `lib/schedule.ts` (three debounces, two polls), `RefreshButton`
    (five), plus `lib/grid/pagination.ts` and `lib/grid/exportTable.ts`.
  - `PrefId` is now derived from `Preferences`, so a "go to this setting" id that
    names no real preference is a compile error instead of a silently dead jump.
  - Deleted dead code: `ConnectPasswordDialog` (92 lines, no importers) and its
    i18n keys, `useSavedQueries.byTag`, three unused constants, and the
    `async-trait` dependency.

- **Internal: the five files that had grown past a thousand lines are split by
  responsibility.** No behaviour change beyond the fixes above.
  `SchemaExplorer.tsx` 2842 → 73 (its eight dialogs to `schema/dialogs/`, each
  tree level to its own file, `ConnectionActionsMenu` to `components/connection/`
  where the tree that renders it lives); `DataGrid.tsx` 3592 → 1301 (`GridRow`,
  the filter chips, the search box, the draft row and `GridToolbar` out; row
  selection, column sizing, the Ctrl+wheel zoom, the preference reads, cell
  editing, keyboard navigation and the column definitions into hooks under
  `lib/grid/`); `ConnectionDialog.tsx` 1761 → 1267
  and its 41 `useState`s to 11 (the rail and the form model out); `TabbedArea.tsx`
  1082 → 390 (the tab header and the empty state out); `App.tsx` 820 → 530 (the
  command-line intent handling out). Two orderings were preserved deliberately
  and are now documented where they are enforced: the launch-restore effect
  sequence, and the memoisation contracts of `GridRow` and the tab header.

- **Vitest is set up for the frontend** (`pnpm test`) with characterization tests
  for the pure `lib/` modules and each extracted hook, and CI runs it alongside
  the existing typecheck and Cargo jobs. 160 tests over 18 files, including the
  SQL statement splitter (which the tests found two bugs in, above), the
  command palette's scoring matcher, and the SQL Server `HOST\INSTANCE` split —
  whose authoritative Rust twin had tests all along.

## [1.17.0] — 2026-08-20

### Added

- **A determinate progress bar for the profile/environment import dialogs**, fed
  by a new `huginndb://import-progress` event emitted from
  `apply_profile_imports` (`src-tauri/src/commands/connection.rs`) once per
  profile as it works through the exported list. Now that the import runs off
  the main thread (see the "not responding" fix below), the window stays
  responsive during a large import, but the disabled button gave no sense of
  whether it was almost done or stuck — a real concern once the operation can
  legitimately take tens of seconds. `ImportProgressBar`
  (`src/components/connection/dialogs/`) renders "N of total" and is shared by
  both `ImportProfilesDialog` and `ImportEnvironmentDialog`, each attaching a
  scoped `listen()` for the duration of its own `doImport` call.

- **"Mark all as: …" bulk actions above the conflict list** in both import
  dialogs (`ConflictBulkActions`, `src/components/connection/dialogs/`), so
  resolving a bundle with dozens of conflicting profiles — the exact case a
  multi-environment import produces — no longer means clicking
  Rename/Overwrite/Skip on every row individually. Sets every conflict's
  resolution at once via the same `resolutions` map the per-row buttons write
  to, so nothing downstream needed to change.

- **A library of user-defined JSON Schemas, and per-column bindings that make the
  cell editor schema-aware.** A HuginnDB used as a configuration store ends up
  with `json`/`jsonb`/`TEXT` columns holding documents hundreds of lines long that
  have a real, if unwritten, contract — and the cell editor treated every one of
  them as anonymous JSON: syntax highlighting, a valid/invalid badge, and nothing
  else. You now keep a library of schemas (a name, an optional description, and
  the document exactly as you typed it, in a `json_schemas.json` of its own) plus
  a separate list of bindings saying which columns each one applies to. Attach one
  and Monaco starts completing property names, suggesting enum values, showing each
  property's `description` on hover, and underlining values that do not fit. The
  completion and the hover documentation are the part that changes a working day;
  the validation is the smaller half.

  The library is **global — not scoped to an environment**, and that is a
  deliberate reading of what a binding means. A binding says "this table's column
  looks like this", which is a fact about the *server*, not about whether you are
  looking at Production or Staging. Scoping it to an environment would give the
  same table a schema in one environment and not in another, which is the
  `visible_databases` bug (gotcha #27) a third time. It also lives in a file of its
  own rather than in `prefs.json`, because a real schema body is 50–200 KB and
  `prefs.json` is rewritten on every `Ctrl`+wheel of the grid.

- **Validation never blocks a save, by construction.** Nothing in the commit path
  reads markers, and the diagnostics are configured at warning severity so a
  violation does not even *look* like it blocks. The database is the authority; a
  schema is an aid. The day someone's schema is slightly wrong they can still edit
  their own data.

- **A most-specific-wins cascade, implemented once, in Rust.** A binding names a
  connection, a schema/database, a table and a column; every axis but the column
  may be "any", and the table and column accept a simple `*` glob, so one rule can
  cover `*_json` across a whole server or exactly one column of one table.
  Specificity runs `column > table > schema/database > connection`, and connection
  being the *lightest* axis is the counter-intuitive part that makes the motivating
  case work: a blanket rule over a whole connection must lose to a rule naming the
  exact table and column, while between two otherwise identical rules the pinned
  one should win — which is precisely what a tie-break axis is for. So a default
  schema for `configuration` everywhere plus one override on the table whose shape
  differs is two rules, not twelve. The frontend never re-derives any of this: it
  would be a second implementation of one grammar (gotchas #30/#33), and the drift
  would be silent, because a resolution bug is not an error — it is "the completion
  did not appear", which nobody reports. Resolution is one call per data tab,
  cached per relation, so the granularity rather than the language answers the
  performance question.

- **"Create from this value", because asking anyone to write a JSON Schema by hand
  has an adoption rate near zero.** The badge drafts one from the document in front
  of you: name it, review the draft, and it is created and linked without leaving
  the editor. Its rules are documented rather than magic, and two of them exist to
  stop it producing a schema that rejects the rows it was drafted from: `required`
  is the *intersection* of keys present in every sample, never the union, and an
  `enum` is only written when a value actually repeated — three distinct values
  across three rows is a sample size, not a closed domain. It always states
  `$schema`, which is load-bearing rather than decorative: without it the language
  service validates with 2020-12 semantics instead of draft-07. Output is
  byte-stable for the same input, so regenerating a schema produces a readable diff.

- **Three surfaces bind a column, in decreasing order of how often you will use
  them.** The one that matters is a **badge in the cell editor's header rail** (in
  both the modal and the docked side panel), beside the JSON-valid chip: it names
  the resolved schema, reads "no schema" in low contrast when there is none, and its
  dropdown links any library entry, drafts a new one, or unlinks. This is the
  universal surface — it is the only one MongoDB and SQL Server have. Second, a
  **new Settings → JSON Schemas section**: the library on the left, the selected
  entry's document on the right in a Monaco pane that edits in place and expands to
  fullscreen with F11 rather than stacking a second modal, and the full bindings
  table underneath in resolution order. Third, a **per-column field in the table
  structure editor**, deliberately fenced off — see *Changed* below.

- **The bindings table shows the cascade rather than listing it.** A wildcard axis
  draws the glyph `*` and never an empty cell, because an empty cell reads as "not
  filled in yet" — the most common misreading of any precedence table. Row order
  *is* precedence, since the backend returns bindings ranked. And a **"Test a
  column"** box answers the question this feature will generate most — *why is my
  rule not applying?* — through the same resolver the editor uses, so the answer
  cannot disagree with what happens while editing. A live match counter was the
  alternative and is worse: it would have to walk the catalogues of every live
  connection and would still only cover whatever happens to be connected.

- **Standalone export/import (`meta.kind = "json-schemas"`), plus opt-in inclusion
  in an environment export.** No passphrase in either case: a schema carries no
  secret and no keychain material. The interesting rule is what happens to a
  binding pinned to a *connection*, since a connection id is a uuid local to the
  machine that minted it: on import elsewhere such a binding arrives **switched
  off**, with its original scope preserved. It is not widened to "any connection"
  (that would change what the rule means) and not dropped silently (that would lose
  the intent with no way to notice) — and the import wizard states the count before
  writing anything. An environment import translates instead, through the same
  original-to-new id map `launch.visible_connections` already uses.

- **A new user guide, `docs/JSON_SCHEMAS.md`** (with its Spanish twin), in the repo
  and under Help → Documentation. It covers the 30-second route, the cascade with a
  worked two-rule example, the exact limits of the drafted schema, the sharing
  caveat, and a "what this is not" section — including the three language-service
  behaviours that are surprising enough to be support questions: a document's own
  `$schema` takes precedence over its binding, one unresolvable `$ref` stops the
  whole document being validated, and nothing is ever fetched from the network.

- **Three preferences — validation, completion and hover.** Split because the
  language service splits them: a rough schema is useful for completion long before
  anyone wants red underlines. They live in the JSON Schemas section rather than
  under Editor, the same call `AppearanceSection` already makes for the data-view
  group. Also four new command-palette actions and three jump-to-setting entries.

- **Shared origins can now publish and continuously sync a whole environment
  (#108), not just loose connections.** Until now `sync_origin` always
  assumed the file was a plain profile bundle (`meta.kind = "profiles"`);
  pointing an origin at an environment export (`meta.kind = "environment"`,
  the same file `export_environments` already writes) silently synced only
  its `profiles` and dropped every `environments` entry, since `serde_json`
  ignores unknown fields rather than erroring. `sync_origin` now reads the
  file's own declared kind and, for an environment export, reconciles a local
  mirror environment on every pull: creating it the first time, refreshing
  its name/color/icon/theme and connection membership (`launch.visible_connections`)
  on every sync after. The match across repeated syncs is by
  `(origin_id, origin_source_id)` — the publisher's own `Environment.id` at
  export time, a new field on `ExportedEnvironment` — not by name or position
  in the file, both of which can change between syncs. A mirrored environment
  is read-only in the rail/switcher (renamed/recolored/deleted only via
  adopt/retire, exactly like an origin-owned connection profile already was)
  and, if its bundle disappears from a later sync, is reported as vanished
  rather than deleted — same "report, never destroy on our own initiative"
  rule the connection side already followed. Deliberately does **not**
  auto-register the origins nested inside the bundle: a shared file must
  never be able to make a machine register more origins on its own, that
  stays reserved for the conscious, one-shot `import_environment`.

- **Column reordering in the table structure editor, MySQL only.** Up/down
  arrows next to each row (revealed on hover, next to the existing delete
  icon) let you move a column without dropping and re-adding it. Designing a
  brand-new table allows reordering on every driver — it's just column array
  order feeding one `CREATE TABLE` — but repositioning a column on a *live*
  table needs a real `ALTER`, and only MySQL's `MODIFY COLUMN`/`ADD COLUMN …
  FIRST|AFTER col` can express that; Postgres has no equivalent ALTER at all,
  and SQLite would mean forcing the 12-step rebuild for what is otherwise a
  no-op change. `db::ddl::mysql_column_positions` diffs the desired column
  order against where each surviving/new column would naturally land (an
  unmoved `MODIFY`/`ADD COLUMN` leaves a column in place / appends it at the
  end) and only emits a position clause for the columns that actually need to
  move, so an unrelated edit elsewhere in the table never gets a spurious
  reorder statement.

### Changed

- **The cell editor now gives Monaco a stable model `path`.** This was the enabling
  change for everything above: schemas attach by `fileMatch` against the model URI,
  and the auto-generated `inmemory://model/N` a bare editor gets matches nothing
  that can be registered, so no schema could apply at all. The path carries which
  surface owns it, because the modal and the docked panel can be open at once and
  two editors sharing a path share a model — whichever unmounted first would destroy
  it under the other.

- **The inline expand buttons say when a schema is attached**, rendering `{}`
  instead of the expand glyph and naming the schema in their tooltip. Double-click
  still opens the same one-line inline editor (gotcha #12 stands); only the icon and
  the tooltip changed. A one-line `<input>` cannot offer completion or validation,
  so the only useful hint is that escalating is worth it.

- **A bound column forces the editor into JSON mode**, overriding the content-type
  heuristic. That heuristic only answers "json" when the text parses, which would
  leave a momentarily-broken document with no validation at all — precisely when it
  is most useful. A binding is the user asserting the column holds JSON.

- **The table structure editor gained a per-column `{}` affordance, fenced off from
  the DDL.** A binding is local editor metadata, not a schema change: it lives in
  its own state rather than on the working column, so it cannot ride into the
  `preview_structure_change` payload or re-trigger the debounced DDL preview
  (gotcha #16). It saves the instant it is picked, sits behind a dashed divider
  under a `local` tag, and is disabled while designing a table that does not exist
  yet. Column renames are followed after a successful apply, best-effort — the DDL
  has already run, so a failure there is a toast and never a rollback.

- **`ExportEnvironmentDialog` grew an opt-in "Include JSON Schemas and their
  bindings" switch.** Schemas are global, so this packs the whole library alongside
  the environment rather than making them part of it — one file to set up a new
  machine.

- **Deleting a connection now also drops the bindings pinned to it**, reporting how
  many. A profile id is a uuid that is never reused, so such a binding can never
  match again: it is a provably dead rule rather than something inert but possibly
  meaningful, which makes it a keyed payload worth reaping (gotcha #27). The
  asymmetry is what makes that safe — the schema, the expensive artefact, is never
  touched.

- **Bulk-deleting connections, deleting an environment, and removing a
  shared origin now use a real confirm dialog instead of the native
  `window.confirm`.** The dialog for removing an origin also states up front
  how many connections and environments it published will be flagged as
  orphaned by the fix above, so "what it published stays" isn't an abstract
  warning.

- **Shared origins moved from per-environment to a global registry**
  (`tab_state.json` v5: `Environment.origins` → the top-level
  `PersistedTabState.origins`). An origin describes a server-side resource, not
  a Producción/Staging axis, and what it produces — `profiles.json` entries,
  whole mirrored environments — was already global; scoping the *registration*
  to one environment reproduced the `visible_databases` bug one level up (the
  same shared file needed a second, independent registration to be seen from a
  second environment) and meant deleting whichever environment happened to
  hold the registration silently orphaned every connection it had ever
  imported. `add/update/remove/sync/list_origins` all operate on the global
  list now; `export_environments`/`import_environment` derive an environment's
  bundled origins from what its connections (or its own mirror) actually
  depend on rather than copying a per-environment list verbatim. Existing
  installs migrate automatically: two environments that had each registered
  the same `path` independently dedupe into one global entry (first one seen
  keeps its id), and every dangling reference — a profile's `origin_id`, a
  mirrored environment's `origin_id` — is remapped to the surviving id.

- **The File menu's import/export items are now grouped under a section header
  per type** (Profiles / Environments / JSON Schemas) instead of separated by
  bare `DropdownMenuSeparator`s. With six lookalike "Import…"/"Export…" rows in
  a row, an empty separator read as "unrelated item boundary" rather than "new
  category" — reuses the same inline-header idiom `ViewMenu` already applies
  to its "Panels"/"Schema tree" groups. Import is now listed before export in
  every section (Environments and JSON Schemas were Export-then-Import; only
  Profiles already read that way). "Import environment…" is renamed "Import
  environments…" (and its dialog title/file-picker title likewise) since one
  file can bundle more than one environment, matching "Export environments…".

- **Restyled the "What's new" dialog (`WhatsNewDialog`) to match the brand
  identity, and rewrote its 1.17.0 hero line.** The dialog previously used a
  generic `Sparkles` chip and a full paragraph as the tagline; it now leads
  with the sticker mark over the halftone wash (the same device
  `AboutSection`/`EmptyState`/the splash screen use), so it repaints with
  whatever theme is active since every colour is a semantic token. The
  tagline is now one punchy sentence that says what the release is about at a
  glance, instead of a summary of every highlight. Each highlight body clamps
  to two lines with a WhatsApp-style "Read more"/"Read less" toggle
  (`HighlightBody`) — recent releases carry enough nuance that a body
  regularly runs 4-5 lines, and the toggle only renders once the clamped
  text is confirmed to overflow (`scrollHeight` vs `clientHeight`), so a
  short highlight never grows a dead button that expands to identical text.

- **The cell editor dialog's chrome (`CellEditor`) was rebuilt to match the
  rest of the app instead of a pre-branding leftover.** Its header used to be
  a second, independently bordered and shadowed card floating inside the
  dialog's own border — two nested outlines that read as pointless, and which
  pushed the dialog's built-in close button into the low-contrast gap between
  them, making the `×` nearly invisible. The header and footer are now
  edge-to-edge with a single `border-b`/`border-t`, the same convention
  `SettingsDialog` and the just-restyled `WhatsNewDialog` already use, so the
  close button sits directly on the header surface with proper contrast
  instead of floating in a seam.

- **The JSON Schema badge inside the cell editor's toolbar
  (`SchemaBindingBadge`, new `className` prop) is now a proper outline button
  pinned to the toolbar's right edge**, sharing `buttonVariants` with the
  neighbouring "Format" button instead of rendering as a tiny mono/10px pill
  that read as a stray tag rather than a control. The bound/declared states
  keep their brand/warning tint, just at button scale. The structure editor's
  inline `variant="compact"` chip (one per table row) is unchanged.

### Fixed

- **A hand-typed SELECT with no `LIMIT`/`TOP` over a large table could take
  down the whole app with an out-of-memory crash, and the "Run" button's timer
  kept spinning the entire time it happened.** Reported against SQL Server (a
  query pasted straight from SSMS over a multi-million-row table), but the
  root cause was shared by every SQL driver: `execute_query`/`execute_batch`
  (`src-tauri/src/commands/query.rs`) handed the editor's SQL straight to
  `sqlx::query(..).fetch_all(..)` for Postgres/MySQL/SQLite and to
  `tiberius`'s `simple_query(..).into_results()` for SQL Server, both of which
  buffer the *entire* result set in memory before returning a single row — and
  `DataGrid` then rendered every one of those rows into the DOM (see the
  virtualization fix below). None of this was time-bounded either: the
  elapsed-time readout next to "Run" is a cosmetic `setInterval`, not a real
  timeout, so nothing in the chain ever cancelled the driver call — the query
  ran to completion (or exhausted memory first) regardless of how long the UI
  had been sitting there. MongoDB's `find`/`aggregate` shell statements had the
  same unbounded-cursor shape.

  Every ad-hoc read path (`execute_query`, `execute_batch`, and MongoDB's
  `find`/`aggregate`) now keeps at most `MAX_ADHOC_QUERY_ROWS` (50,000) rows,
  via a new generic `fetch_capped` helper that streams a SELECT with sqlx's
  `fetch()` instead of `fetch_all()`, a new `simple_query_sets_capped` on the
  SQL Server pool that walks `tiberius`'s `QueryStream` item-by-item, and a
  `collect_capped` for Mongo cursors. Rows past the cap are still drained (SQL:
  so the pooled connection/session is left at a clean protocol boundary
  instead of mid-response — dropping the stream early would corrupt the next
  caller's query on that same connection; Mongo: the cursor is simply dropped,
  which is a supported operation) — discarded, not merely deferred, so backend
  memory stays bounded no matter how many rows the query actually matches.
  `QueryResult.truncated` reports when this happened, and the grid now shows a
  "truncated" badge in the toolbar (with a hint to add a `LIMIT`/`TOP`) instead
  of silently handing back a partial result with no indication anything was
  cut. `fetch_table_data`/`fetch_collection_data` (the paginated table/
  collection browser) are unaffected — they always apply their own
  `LIMIT`/`OFFSET` and never truncate.

  `DataGrid.tsx`'s row rendering is now backed by `@tanstack/react-virtual`
  instead of mounting one real `<tr>` per row unconditionally — the file's own
  header comment used to (incorrectly) claim rows were "virtualised by the
  browser via the parent's `overflow-auto`", which is not how `overflow-auto`
  works and is exactly what let a 50,000-row capped result still bog down the
  renderer even after the backend stopped running out of memory.

- **Removing a shared origin could leave its connections permanently stuck**
  if the in-app "keep as mine / delete" notice was missed before the app
  closed — the notice lived only in memory (`useOriginSync.vanished`), so an
  app restart lost it for good, and a connection tagged with a dangling
  `origin_id` is read-only and un-deletable in the UI with no other way to
  clear the tag. `syncAll()` now also runs a reconciliation sweep on every
  pass (launch, the 4-hourly poll, and "Sync now") that catches any profile or
  mirrored environment whose `origin_id` doesn't match a currently registered
  origin and raises the same adopt/retire notice for it, without needing the
  origin's name (it's shown as "a shared origin that no longer exists"). The
  "Sync now" button in Settings → Origins no longer disables itself when zero
  origins are registered, since this sweep is useful precisely in that state —
  right after removing the last one.

- **Re-importing connection profiles with "overwrite" no longer silently breaks
  anything keyed on the profile id.** `apply_profile_imports` mints a fresh uuid
  even when overwriting an existing profile, which nothing depended on before and so
  was invisible. With bindings in the picture it means an overwrite quietly stops
  every rule pinned to that profile from matching — no error, the completion simply
  disappears, and the delete-time sweep never fires because nothing was deleted. The
  function now returns the overwrite subset of its id map, and both callers use it to
  repoint the affected bindings.

- `EnvironmentImportAnalysis` declared a `totalProfiles` field in `src/types.ts`
  while `transfer.rs` sends `total_profiles`. Nothing read it, so nothing was broken,
  but the next person to read it would have got `undefined`.

- **The environment-import wizard crashed to a blank window on its last step, with
  "Cannot read properties of undefined (reading 'length')" in the console.** This is
  that same snake_case/camelCase mismatch one level over, except this time something
  *did* read the field: `EnvironmentImportAnalysisEntry.connection_count` and
  `ImportedEnvironment.environment_id`/`origin_ids` had no `#[serde(rename_all =
  "camelCase")]`, so they crossed the wire as-is while `src/types.ts` and
  `ImportEnvironmentDialog.tsx` were written expecting `connectionCount`/
  `environmentId`/`originIds`. The review step silently showed "undefined
  conexión(es)"; the done step's `env.originIds.length` threw outright, taking the
  whole dialog tree down with it (React has no error boundary above `FileMenu`).
  Reproduced by importing a multi-environment bundle and choosing "Omitir" for every
  conflicting profile. Both structs now carry `rename_all = "camelCase"` — the
  `EnvironmentImportResult.json_schemas` / `EnvironmentImportAnalysis.total_profiles`
  fields one level up deliberately keep snake_case (see the code comments), so this
  is not a blanket rename.

- **Removing a shared origin no longer orphans what it published forever.**
  `remove_origin` always left the connections (and now environments) it
  imported in place, tagged with a now-dangling `origin_id` — deliberately,
  so a config change never silently deletes a batch of servers someone has
  work open against. But the only mechanism that ever offers to release such
  an entry (`useOriginSync`'s vanished-notice → adopt/retire) was fed
  exclusively by `syncAll()`, which iterates the *currently registered*
  origins — and a removed origin is gone from that list before it can ever
  report anything as vanished again. The connection (or environment) stayed
  permanently read-only and permanently undeletable from the UI, with no way
  out. Removing an origin now raises the same vanished-notice immediately,
  from local state, while the origin's name is still known — reusing the
  existing decide-later flow instead of inventing a second one.

- **Importing a bundle with many encrypted connection profiles no longer
  freezes the window ("not responding" in Windows) for the whole import.**
  `import_environment` and `import_profiles` were declared as plain, non-async
  Tauri commands, which Tauri dispatches directly on the app's main thread
  rather than the async runtime's thread pool. Both call
  `apply_profile_imports`, which runs `transfer::decrypt_secret` once per
  encrypted secret — a 600 000-iteration PBKDF2-HMAC-SHA256 key derivation,
  deliberately slow, with a fresh random salt per secret so there is no shared
  derivation to cache across them. A single-profile import never surfaced
  this; importing 13 environments sharing a pool of connection profiles (22 of
  them conflicting with existing ones) meant dozens of derivations running
  serially, each costing on the order of a hundred milliseconds or more,
  blocking the main thread for long enough that Windows reported the app as
  hung. Both commands are now `async fn`, with the file read, the profile
  merge/decrypt loop, the JSON-Schema binding remap, and the tab-state write
  moved into a `tauri::async_runtime::spawn_blocking` closure — the same CPU
  cost is paid, but off the thread that pumps window messages.

- **The structure editor could reject its own DDL preview for a column
  nobody touched, on MySQL `BIT` columns specifically.** MySQL reports a
  `BIT` column's default from `information_schema` in its native `b'0'`/
  `b'1'` literal form, and the structure editor round-trips that verbatim
  into the "Default" field. `validate_structure` validated every column's
  default against a conservative allowlist (numbers, quoted strings, a
  handful of keywords) regardless of whether the user had touched it, so
  simply opening a table with a `BIT` column and editing an unrelated column
  made the whole preview/apply fail with "unsupported default expression:
  \"b'0'\"" — a comment already flagged this exact class of problem for
  Postgres's cast-style defaults (`'foo'::text`) in the `dump`/SQLite-rebuild
  path, but the structure editor's own `ALTER` path never got the same
  treatment. A column's default now only goes through the allowlist when it
  actually differs from what's on the live catalog; an unchanged default —
  in whatever dialect-native form the server reports it — is trusted as-is.

## [1.16.2] — 2026-08-19

### Added

- **Three new user guides, in the app and in the repo: Connections, MongoDB
  and SQL Server.** Help → Documentation had exactly two entries
  (Environments and the MCP connector), so most of what the app does was
  documented only in the README's feature list or not at all. The new ones
  cover, respectively: creating a connection per driver and what each one
  needs, why SSL is explicit in both directions, SSH tunnels (auth, the
  local-port fallback, host-key policy, and the two cases that can't be
  tunnelled), what "leave the database blank" actually does on each engine,
  where passwords live and what never touches disk, the connection-limit
  preferences and the per-server override, keepalive and the reconnect
  affordance, every CLI flag including the ephemeral-by-construction ad-hoc
  form, encrypted export/import with the MongoDB URI caveat, and shared
  origins with their real threat model — the `mongosh` dialect the query
  editor accepts and what it deliberately refuses, the document editor's
  path-addressing and type fidelity rules, aggregation pipelines and views
  (including why `$out`/`$merge` are refused), the index manager and why
  MongoDB is the only driver with one, renaming/moving a collection, and a
  table of what isn't implemented with the reason — and `HOST\INSTANCE`
  handling with the SQL Browser, certificate trust, Windows auth, how each
  value type is rendered (`decimal` exact, `money` through a double, `bit` as
  0/1, binary as hex), the write-side specifics visible in the Console, and
  the four surfaces still gated off.
- **`docs/README.md` as an index of the docs folder** (with its Spanish
  twin), separating user guides from internal design notes and documenting
  the four steps for adding a guide — the file, the `docs.ts` entry, the i18n
  keys, and the `vite.config.ts` `DOC_FILES` path that injects its
  last-updated date — plus the constraints of the in-app markdown renderer.
  The root README's Docs section now links it and each guide; it previously
  didn't mention `ENVIRONMENTS.md` at all.
- The in-app viewer's entries are ordered by reading order rather than
  alphabetically (Connections → Environments → MongoDB → SQL Server → MCP),
  since the dialog opens on the first one.

- **The list view can now insert a row / document.** "Insert" was hidden
  whenever the grid was in list mode, which left the mode read-mostly: you
  could edit any field of an existing document and delete it, but adding one
  meant switching back to the table view. The draft is drawn as a card pinned
  above the documents — one `key : control` line per field, using the very same
  controls the table's draft row uses (auto-PK placeholder, FK combobox, BIT
  0/1 selector, plain input), now extracted into a shared `DraftCellControl` so
  the two surfaces can't drift on the details that matter (a BIT column has to
  emit the numeric string the backend's `CAST` expects, gotcha #15). It commits
  through the same `insert_row` call: switching view mode changes how the draft
  is drawn, never what it writes. Two deliberate differences from the table's
  row: focus leaving the card does **not** commit (a card is a form, and it
  hosts a type picker whose popover lives outside it — a blur-commit would fire
  the INSERT the moment that picker opened), so Enter or "Save" commits and Esc
  or "✕" discards; and on MongoDB each field carries its own **BSON type
  picker**, sent as `insert_row`'s type hint. That last part is the point of
  doing it here rather than reusing the table's fixed-type row: a collection has
  no schema, so the type a new field is stored with is a choice, and inferring
  it from the text would write an `Int32` into a field the collection holds as a
  `Long` — the fidelity trap gotcha #29 documents for edits, one step earlier.
  The field set is still the result's column list (on MongoDB, the top-level
  keys of the current page); extra fields are added to the new document with the
  per-document `+` once it exists.

### Fixed

- **`docs/MCP.es.md` was missing the whole "Connection footprint" section**,
  including "Sharing the app's pools", and its intro still said the connector
  _cannot_ share the desktop app's pools — which stopped being true when the
  `Share pools with the MCP connector` preference landed. Both are now in sync
  with the English original.

- **SQL Server: negative `decimal`/`numeric` values rendered as a
  malformed string** (`-18.900000000` came back as `-18.-900000000`).
  `tiberius`'s `Display for Numeric` formats the integer and fractional
  halves separately — `write!(f, "{}.{:0pad$}", n.int_part(), n.dec_part())`
  — and both are derived from the same signed `i128` mantissa, so a negative
  value emits its sign twice _and_ loses the zero-padding of the fractional
  part in the same breath: `-18.09` came out as `-18.-9`, `-0.000000001` as
  `0.-00000001`, and a value below 1 lost the sign entirely (`-0.5` → `0.-5`,
  because `int_part()` of it is `0`). A `decimal(18,0)` also grew a spurious
  `.0` tail. `mssql_value` now formats these columns itself from the raw
  mantissa and scale (`numeric_to_string`) instead of calling `to_string()`:
  sign taken off once, magnitude zero-padded to at least `scale + 1` digits,
  split `scale` digits from the right — no `f64` step anywhere, which is the
  whole reason these columns travel as text. Affected every consumer of a
  negative decimal equally: the data grid, CSV/JSON copy-and-export, and the
  `huginndb-mcp` connector, where it was reported. `first_i64` (the
  `COUNT(*)`/row-estimate path) stopped round-tripping through the same
  broken string too — it reads `int_part()` directly, since the rendered form
  of any non-zero scale is not something `parse::<i64>` accepts.

- **A pending insert row appeared and vanished instantly when started from a
  menu.** Reported as "the draft row flashes and is gone"; the toolbar's
  "Insert" button worked, both menu entries (the row's right-click menu and the
  toolbar's overflow menu, which is where the button moves on a narrow pane)
  did not. Both of those are Radix menus, and Radix's `FocusScope` restores
  focus to whatever was focused before the menu opened from inside its own
  `setTimeout(…, 0)` on unmount. The grid focused the draft's first cell in a
  `requestAnimationFrame`, which fired *before* that timeout — so Radix pulled
  focus straight back out of the just-mounted row, the row's focus-leave
  handler ran, and a draft nobody has typed into is silently cancelled (by
  design: it would otherwise send an `INSERT () VALUES ()`). The focus is now
  granted in a `setTimeout` chained *after* the frame, which is always queued
  after Radix's, so the draft keeps focus whichever way the two callbacks
  interleave. The frame is still what waits for the row to mount.

- **Enter or Escape inside an FK value picker committed or discarded the whole
  draft.** The draft binds Enter to "insert this row" and Escape to "discard
  it" at the row level, and `FkCombobox` called `preventDefault` on the keys it
  handles but never `stopPropagation` — so opening the picker with Enter fired
  the INSERT with a half-filled row, and closing it with Escape threw the draft
  away. Both handlers (the trigger and the panel's search field) now stop the
  event at the combobox, which is the only component that has consumed it.

- **The list view's empty state was the one empty screen with no branding.** A
  collection or table with no rows rendered a bare grey "No rows" line, while
  the table view has shown the shared `EmptyState` frame — halftone wash,
  medallion, the sticker mark with a per-state glyph — since the brand pass.
  The list view now uses the same frame (and so does an aggregation preview
  whose pipeline returned nothing), suppressed while an insert card is open:
  the surface is no longer empty, it is a form.

### Changed

- **`docs/MCP.md` (+ the Spanish twin) now documents the two independent
  approval gates a write passes through**, after a report of a connection set
  to `full` whose schema change was still refused — by the AI client, not by
  the connector. New "When the client blocks the call, not the connector"
  subsection: a table for telling a connector refusal (a tool result naming
  the policy, plus a line in `mcp-audit.log`) from a client-side block (the
  call never reaches the connector, so the audit log stays silent), why
  Claude Code's auto-mode classifier treats DDL against a live server as a
  migration against unrecognised infrastructure by default, and the four
  client-side remedies — a one-off retry from `/permissions`, a specific
  request (explicit intent clears the classifier's soft blocks), a
  `permissions.allow` rule for the tool, or `autoMode.environment` /
  `autoMode.allow` entries describing the instance. All of them belong to
  whoever runs the client; documenting them does not loosen the connector,
  whose own policy still applies after the client approves the call.

- **`docs/MCP_CONNECTOR_ROADMAP.md`: an open section on distributing the
  connector through a marketplace instead of a per-machine install.** Records
  the three candidate routes and their verdicts — the claude.ai connector
  directory is not viable (it lists _remote_ servers, and this one reads
  `profiles.json`, the OS keychain and the user's own network), while the
  Claude Code plugin marketplace and a Claude Desktop `.mcpb` extension both
  are — plus the constraint they share (neither can bundle a per-target
  compiled sidecar, so both need a launcher that resolves the installed one)
  and the two prerequisites worth doing regardless: moving the exposed-profile
  list out of `--connections` into HuginnDB's own state, and declaring
  `_meta["anthropic/requiresUserInteraction"]` on the write tools. Also states
  plainly why "the marketplace governs permissions better" narrows to a
  distribution question: approval already belongs entirely to the client, and
  the write policy is a second, server-side ceiling applied after it.

## [1.16.1] — 2026-08-18

### Added

- **Export/import one or more environments as a self-contained bundle.**
  File → "Export environments…" opens a checklist (default: everything
  selected) that writes a single JSON file with each picked environment's
  name/colour/theme, its registered shared origins (name + path only — never
  a passphrase, matching `origins.rs`'s existing threat model of keeping the
  secret out-of-band), and one deduplicated pool of the connection profiles
  any of them reference (a connection shared by two selected environments is
  written once, not duplicated). The same dialog also opens pre-checked to
  just one row from a shortcut in `EnvironmentSwitcher`. File → "Import
  environment…" reads one of these files back and **always creates brand-new
  environments** — one per bundle in the file, never merged into or
  overwritten on top of ones that already exist, so a colleague's exported
  environments can never collide with your own origins, connections, or
  environment list. Deliberately excluded: tabs, dockview geometry and
  launch state, which are session artifacts tied to the machine that
  produced them (see gotcha #10) rather than part of an environment's
  portable identity. Each new environment's connections tree is scoped to
  exactly its own imported profiles via the existing `visible_connections`
  filter (#107), and none of them are auto-connected. Connection-profile
  conflicts are resolved once for the whole file, reusing
  `import_profiles`'s exact conflict-resolution UI (overwrite/skip/rename);
  an imported encrypted origin surfaces the same "no passphrase stored"
  state a freshly-added one does, resolved on the next sync.
- **`.rpm` bundle target**, alongside the existing `.deb`/`.AppImage`, for
  Fedora/openSUSE/RHEL-family distros. Tauri's rpm bundler (the `rpm` crate)
  is pure Rust — no `rpmbuild` or extra system packages — so it builds from
  the same `ubuntu-22.04` release leg with no CI changes beyond the
  `tauri.conf.json` target list. Added `bundle.license: "MIT"` alongside it,
  since an unset License header on an RPM package reads as "Unspecified."
  Smoke-tested via `workflow_dispatch` with the `v0.0.0-test` throwaway tag
  (run #62): both legs completed and the draft release carried a valid
  `HuginnDB-1.16.0-1.x86_64.rpm` alongside the usual assets. That confirms
  the bundler output is well-formed — actual install/launch on a real
  Fedora/openSUSE box is still unverified (see `ROADMAP.md` item 7).
- **Rename a MongoDB collection**, optionally moving it into another database
  in the same operation. `renameCollection` is a run-command on the `admin`
  database that qualifies both sides with a database name, so the move comes
  free with the rename — there is no separate "move" operation to build. The
  entry sits in the collection's context menu next to Empty/Drop, and the
  rename dialog grows a destination-database picker (MongoDB only) with a
  warning that a cross-database move copies the documents server-side and
  needs privileges on both databases. `dropTarget` is always `false`: renaming
  onto an existing collection is an error the user sees, never a silent drop
  of whatever was there. Views are refused up front with a message that says
  what to do instead — MongoDB has no rename for a view, only drop + recreate,
  which is why the view editor has never offered one either. Rename is now
  gated by its own `supportsRenameTable` capability rather than by
  `supportsDdlEditing`: it needs no DDL builder, which is exactly why MongoDB
  can have it while structure editing stays read-only there.
- **A dedicated "Refresh schema" shortcut** (default `Ctrl+Shift+R`),
  rebindable alongside the others in Settings → Shortcuts. `F5` still
  refreshes the active grid's rows; this one re-reads the catalog.

### Fixed

- **"Refresh" now reloads the database you are actually looking at.** On a
  multi-DB connection the tables live in the synthetic `<parent>::db::<db>`
  child slices, but the Database node's menu, the connection row's menu and
  the command palette all refreshed the _parent_ id — re-fetching a table list
  nobody renders (on MySQL the parent pool has no database selected at all, so
  it is legitimately empty) and leaving the visible subtree untouched. A table
  created outside the app never appeared no matter how many times Refresh was
  clicked. The new `useSchema.refreshTree` refreshes a connection together
  with every per-database view opened beneath it, and the Database node
  refreshes its own child explicitly.
- **A refresh now invalidates cached columns and indexes.** It only ever
  re-fetched the database and table lists, spreading the rest of the slice
  through untouched — and since the explorer deliberately only loads a table's
  columns when they are _absent_ (so collapsing and re-expanding doesn't
  re-query), a column added outside the app stayed invisible until the
  connection was dropped. Expanded tables are re-loaded immediately after the
  wipe, so an open node comes back with its current columns.
- **SQL Server: `SERVER\INSTANCE` is accepted, in either field.** SSMS has
  a single "Server name" box and splits the combined form itself; HuginnDB
  split nothing, so pasting it into the instance field produced a SQL Browser
  lookup that could never match (the Browser only reports the bare instance
  name) and pasting it into the host field failed DNS resolution with an error
  that never mentioned instances. Both fields now normalise through
  `split_instance`, on the backend (authoritative — it also covers the CLI and
  the MCP connector) and in the connection dialog on blur, so the user sees
  the split rather than having it happen silently.
- **SQL Server: a stopped or firewalled SQL Browser no longer blocks a named
  instance with a static port.** UDP 1434 is a separate service from the
  instance's own TCP port; when the Browser doesn't answer, the port typed in
  the dialog is now tried before giving up, and a failure reports both causes
  instead of only the last one. A port left at the default 1433 is
  deliberately not treated as a static-port hint.
- **SQL Server: the "named instance cannot be tunnelled" refusal is raised
  before the SSH tunnel is opened**, instead of after paying for the handshake.

- **Clicking a table row in the schema tree almost anywhere but its name
  expanded the column preview instead of opening the table.** `TableRow`
  wrapped the whole row — chevron, icon, name, "open in tab" dot and metric
  badge — in a single button that toggled the column list, with only the
  name `<span>` carved out via `stopPropagation` to open a tab instead. Every
  IDE this project takes cues from binds a plain click on the row to opening
  it, so aiming for the row and landing a pixel outside that narrow name
  span kept surprising users with an unwanted expand/collapse. The row now
  renders two sibling buttons: a dedicated chevron-only button that toggles
  the columns (with `schema.expandColumns`/`schema.collapseColumns`
  aria-labels, en/es), and a second button covering everything else that
  opens the table tab.

## [1.16.0] — 2026-08-17

### Added

- **MongoDB indexes can be inspected and edited, from a dedicated index
  manager.** They were visible but untouchable: the structure tab listed them
  read-only, `apply_structure_change` rejects MongoDB, and the query editor's
  statement parser has never known `createIndex`. Managing an index meant
  leaving HuginnDB for `mongosh`. **Indexes…** on any collection now opens a
  tab listing the real catalogue, with create, hide, replace and drop.
  - **The list is a tool, not a catalogue.** Alongside the keys and their
    properties it shows each index's **size** and how many operations it has
    served since the counter was last reset. An index with months of uptime and
    zero uses is one nobody queries and every write pays to maintain — the most
    useful thing this view can tell you, and the reason it isn't just a list of
    names. Both columns come from `$collStats` / `$indexStats`, which need their
    own privileges, so they are omitted rather than shown as zeros when the
    connection's role can't read them.
  - **Hide sits next to drop, deliberately.** A hidden index is ignored by the
    query planner while the server keeps it up to date, so the effect of
    removing one can be measured and undone instantly. Dropping a large index
    and changing your mind costs a full rebuild.
  - Creating covers the keys (per-key direction or type, through a picker, with
    a raw-text mode for anything exotic), `unique`, `sparse`, `hidden`, TTL,
    partial filter expressions, collations, text weights and a merge-anything
    escape hatch for options the form has no field for. **Editing is a drop
    plus a create** — MongoDB cannot alter an index in place — which the dialog
    states and a confirmation repeats before it runs.
  - **Nothing the server reports is dropped in silence.** The catalogue is read
    from the raw `listIndexes` documents rather than through the driver's typed
    `IndexModel`, which keeps only names, field names and `unique`; every option
    beyond those — including ones a future server adds — survives to the editor
    and back. Reusing that typed shape would have rebuilt `{ createdAt: -1 }`
    ascending the first time anyone corrected a typo in it.
  - `_id_` is refused for drop, hide and replace by the backend, not merely
    greyed out.

- **MongoDB views are editable, through a Compass-style aggregation editor.**
  Until now a MongoDB view could be browsed but not changed: `commands/view.rs`
  rejects MongoDB on purpose, because a Mongo "view" has no `CREATE VIEW` body
  to diff — it is a stored aggregation pipeline over a source collection
  (`{create|collMod, viewOn, pipeline}`). The new aggregation editor is the
  parallel surface, and it opens two ways: **New aggregation…** on any
  collection (a scratch pipeline, which "Save as view" turns into a real view),
  and **Edit pipeline…** on any view (its pipeline loaded, saving runs
  `collMod`). Dropping a Mongo view also works now — `drop_view` grew a Mongo
  arm, since that one operation needs no DDL at all.
  - **Two modes over one pipeline.** _Stages_ gives each stage its own card
    with its own output — the pipeline truncated after that stage — which is
    what makes a sixteen-stage `$lookup` chain readable instead of one opaque
    result. _Text_ is the whole array in a single editor with the pipeline's
    output beside it. Switching between them is a conversion routed through the
    backend (`format_mongo_pipeline`), because splitting an array literal into
    stages needs the grammar and a stage body is full of commas.
  - **The stage rail is a health strip, not a breadcrumb.** Every stage is a
    chip, in order, carrying the number of documents it emitted in the sample
    (`10+` when the sample hit its limit). Read left to right it shows where a
    pipeline's data dies: the `$match` that empties everything downstream takes
    a `warning` accent at zero, an errored stage a `destructive` one.
  - Stages can be switched off without being deleted (they stay in the document
    and out of every request, and are never written into a saved view),
    reordered by dragging, collapsed, and re-typed through the stage picker —
    which replaces the body only when it is still an untouched snippet, and
    otherwise rewrites just the operator key so a mis-click costs one undo.
  - **Export pipeline** copies the enabled stages as a `mongosh` call, the bare
    pipeline, or a `db.createView(…)` snippet — the last being what a pipeline
    turns into once it stops being an exploration.
  - Pipelines are written in the same relaxed grammar the query editor already
    speaks (unquoted keys, single quotes, `ObjectId(…)`/`ISODate(…)`, and now
    `//` and `/* */` comments), parsed by that one parser in Rust — the
    frontend never parses a pipeline. Reading a view back renders its stored
    BSON as that same source (`bson_to_shell_text`), so an `ObjectId` in a
    `$match` stays an `ObjectId` and a `NumberLong` stays a `NumberLong`
    across an open-and-save round trip, rather than degrading to a string or
    an `Int32` that silently stops matching.
  - `$out` and `$merge` are refused before anything reaches the server: the
    editor previews on a debounce as you type, and a "preview" that overwrites
    a collection mid-edit is not one. Every preview is bounded by a `$limit`
    (10 documents by default, selectable up to 50).
  - A new Monaco language colours the two things that carry meaning in a
    pipeline apart — an operator key (`$match`, `$sum`) reads as a keyword, a
    field reference (`"$customerId"`, `"$$NOW"`) as a predefined name — with
    completions for stages, expression operators and BSON constructors. It
    uses the token names every theme already styles, so custom themes colour
    pipelines without knowing it exists.

### Changed

- **Every built-in theme now ships as a light/dark pair, and the roster was
  trimmed and rebalanced accordingly.** Removed `Dim` and `Solarized Dark` —
  both were single-mode presets nobody could toggle out of without landing on
  a HuginnDB default (see the Fixed entry below), and neither had enough of
  an identity to justify building a counterpart for. Added `Summer Dark` (a
  night-beach palette keeping Summer's coral/teal hues, brightened for a dark
  surface, the same way Claude Dark brightens Claude Light's terracotta),
  `Neon Light` (the lab-on-paper counterpart to Neon's near-black palette —
  every saturated hue deepens to stay legible on a bright surface, but the
  green primary/brand, cyan `fk`, yellow `pk`/`numeric` and hot-pink
  `destructive` keep the family recognisable), and `High Contrast Light` (the
  same maximum-contrast idiom inverted to white/black, keeping the identical
  signal yellow for primary/brand/ring). Ten built-in themes in total now:
  HuginnDB, Claude, Summer, Neon, and High Contrast, each with a light/dark
  pair.
  - The Appearance settings page's 26-colour editor was a single flat
    2-column grid in declaration order — unrelated tokens (say, `border` next
    to `input`, three rows after `brandHover`) sitting side by side with no
    visual grouping. It's now split into four labelled sections — Surfaces,
    Actions & brand, Status colours, Borders & focus — via a new
    `COLOR_GROUPS` export in `lib/themes.ts`, so a background/foreground pair
    and its siblings read together instead of being found by scrolling.
- **The whole interface now follows the HuginnDB brand visual language.** The
  logo's world — soft black outlines, rounded corners, light volume, one
  electric blue — is applied as a _contained_ layer over the existing
  keyboard-first tool: the working surfaces (grid, SQL, JSON) stay quiet, and
  the personality shows up in affordances, states and empty screens.
  - The two default themes were repainted on the brand palette: a slate/navy
    ramp in four depth levels (`#020617` → `#0b1220` → `#111827` → `#1e293b`)
    under a single `#2563eb` accent in dark, and white → `#f8fafc` → `#eef5ff`
    over `#d6e4f5` borders in light. The other presets (Dim, Solarized, Claude,
    Neon, Summer, High Contrast) are untouched.
  - New `brand-hover` theme token: the accent under the pointer is now a real
    colour per theme (lighter in dark themes, deeper in light ones) instead of
    `brand/90`, which faded the accent into the surface exactly when it should
    light up. It is editable like any other colour in Preferences → Appearance.
  - Buttons: 12px corners, a 2px edge on the filled variants, and a hover that
    lifts 1px into a short brand glow. Inputs, textareas and selects share one
    clean focus treatment — the border turns brand blue with a soft 3px halo,
    replacing the detached offset ring.
  - Menus, popovers, tooltips, selects and dialogs now open with the same
    fade + 98→100% scale inside the 150–220ms motion band, and sit on the
    shared elevation ramp instead of ad-hoc shadows.
  - Panel drag-and-drop targets, the active sash and a checked switch are blue
    (they are affordances); toast edges are colour-coded per outcome at one
    shared weight, with success finally green and warning theme-aware instead
    of a hard-coded amber.
  - The activity bar and the environment rail now mark the active entry with a
    4px rounded bar flush against the rail edge (brand blue in the activity
    bar, the environment's own colour in the rail) and tint the selected icon
    blue. Both rails and the chrome footer buttons gained keyboard focus rings.
  - The selected connection in the tree carries the same blue rail the active
    table row already had, plus a hairline blue edge; connection cards in the
    launcher lift 1px on hover and the active one sits inside a subtle blue
    glow.
  - Data grid: headers are semibold on a slightly elevated surface, and every
    cell separator now comes from the `border` token instead of a flat
    foreground alpha — a softer, theme-aware hairline. Column resizing (handle,
    hover, in-progress column) is blue like every other affordance.
  - **New "HuginnDB Dark" / "HuginnDB Light" editor themes** (Preferences →
    Editor), painted in the app palette: the editor background matches the
    panel exactly, the active line is a soft blue lift with Monaco's default
    box border suppressed, keywords take the brand blue and numbers the same
    amber the grid uses for numeric cells. `huginn-dark` is the new default for
    fresh installs; an install that already picked an editor theme keeps it.
  - The cell editor's header is now a rounded, slightly elevated rail with an
    icon for the detected content type, and fullscreen is a small sticker chip
    that finally shows its own shortcut (F11) instead of an anonymous icon.
  - **Empty screens are a family now**, not four unrelated grey lines: one
    shared frame (`EmptyState`) with a halftone wash, an outlined medallion
    holding the glyph and room for a hint, adopted by the connections tree, the
    console, saved queries and an empty result set. The medallion is the slot
    the sticker illustration drops into later.
  - **The new comic logo replaces the old raven/rune mark everywhere**: every
    app/installer icon size was regenerated from it (Windows, macOS, Linux,
    plus the Android/iOS sets), the empty workspace shows the full lockup, the
    About card leads with the mark over a halftone wash, empty states show it in
    their medallion with the per-state glyph as a corner badge (over a dot field
    that now spans the whole surface, lit by a blue bloom under the mark), and
    the dev browser tab finally has a favicon. Masters live in the new `brand/`
    directory, outside `public/` so 2.5MB of source artwork stays out of every
    installer; `public/image/` keeps only what the app renders, at the size it
    renders it.
  - The Windows icon was rebuilt for small sizes: the artwork is cropped to its
    own content (the master's transparent margin was costing ~10% of every
    canvas), every size is resampled by repeated 2:1 halvings with a light
    unsharp pass at 32px and below, and `icon.ico` now carries the full ladder
    — 16/20/24/32/40/48/64/96/128/256 — including the 20px and 40px entries
    Windows asks for at 125% and 250% display scaling and used to have to
    improvise by rescaling a neighbour. The "H" stays readable in the title bar,
    the taskbar and Explorer instead of turning into a blue smudge.
  - **New launch splash**: the mark over a halftone wash and a blue bloom, on
    screen for about half a second and then gone. It is an overlay inside the
    existing window, not a second Tauri window, and it never blocks or waits on
    session restore.
  - Microdetails: resize handles are rounded and turn blue while grabbed;
    connection state dots carry a soft halo of their own colour (the lit dots on
    the logo's cylinder); jumping to a preference from the command palette
    pulses it blue once before settling into its ring; the two state banners
    that used a lighter border than the rest now match.

### Fixed

- **Toggling light/dark mode on a built-in theme other than the two HuginnDB
  defaults reset it to `HuginnDB Dark`/`HuginnDB Light` instead of switching
  to that theme's own counterpart (issue #132).** `setActiveMode` looked up
  the target with `BUILT_IN_THEMES.find(t => t.id === mode)` — a literal
  match against the _mode string_ `"dark"`/`"light"`, which only ever
  resolved to the two themes whose `id` happens to equal their mode. Every
  other preset (Claude, Dim, Solarized Dark, Neon, Summer, High Contrast) hit
  no match, silently fell through to a dead branch that mutated `mode` on a
  theme never actually written back to `customThemes`, and the toolbar's
  dark/light select simply landed the user on whichever HuginnDB default
  matched the target mode. Fixed by giving every built-in theme an explicit
  `pairId` pointing at its light/dark counterpart (`lib/themes.ts`) and
  having `setActiveMode` resolve through it instead of guessing from the mode
  string. This is also why every built-in now needs a real counterpart — see
  the Changed entry above.
- **Replacing an app icon no longer leaves the old one embedded in the
  binary.** `tauri_build::build()` declares only `tauri.conf.json` and
  `capabilities/` as build inputs, and cargo tracks _only_ what a build script
  declares — so changing `icons/*` left the crate looking fresh while both
  compile-time copies of the icon (the executable's Win32 resource and the
  generated context's `default_window_icon`) kept the previous artwork, with no
  error and nothing a frontend rebuild could fix. `build.rs` now declares the
  six icon files, so touching one forces the relink.
- The active-environment marker in the left rail was never visible: it was
  offset 8px outside a full-width button, which put it beyond the shell's
  `overflow-hidden` boundary. The read-only rail button secondary windows
  render carried the same bug and is fixed with it.

- **A secondary "New window" showed every saved connection from every
  environment, with no rail to tell them apart.** `EnvironmentRail` and
  `EnvironmentSwitcher` already hid themselves outside the main window
  (gotcha #8 — only main writes `tab_state.json`), but nothing filled in the
  connection/database visibility filters (`useUi.visibleConnections` /
  `databaseVisibility` / `collapsedConnections`) for a secondary window
  either, since `restoreSession`/`switchTo` were both hard-gated to the main
  window. Because connection profiles are global, not partitioned per
  environment, the tree fell back to its "no filter" default: show
  everything. `list_environments` already returns every environment's full
  `launch` snapshot, read-only, so the fix stays on the frontend:
  `useEnvironments.load()` now seeds a secondary window's own filters from
  whichever environment is active, and `switchTo()` gained a real branch for
  non-main windows that re-points those filters locally — never touching
  `set_active_environment`, pools, tabs or `tab_state.json`. Each window
  already has its own JS process and its own Zustand store, so this can't
  leak between windows. `EnvironmentRail`/`EnvironmentSwitcher` now render in
  every window, with create/rename/delete/reorder (the actions that do write
  the shared file) hidden outside main — so several windows can each sit in a
  different environment at once, independently.

- **Switching a table's row layout (table/list) in one window silently
  switched it in every other open window and tab too.** The toggle wrote
  `documentViewMode`, a field inside the single `Preferences` blob the
  backend intentionally broadcasts to every window on save (most of
  `Preferences` genuinely is app-wide, e.g. row height). Moved it onto each
  table tab's own view state (`TabViewState`/`PersistedTab`), the same
  mechanism already used for a tab's filters/sort/search — a tab now owns its
  row layout independently of other tabs and other windows, seeded once from
  the (unchanged) global default the first time it's opened.

- **The environment rail scrolls, and Theme/Settings stay reachable.** The rail
  was one flat column with its footer pinned by `mt-auto`, which only pins
  while there is free space. At around eight or nine environments the avatars
  filled the rail, pushed the theme toggle and the settings button past its
  bottom edge, and the shell's `overflow-hidden` clipped them away — with no
  scroll to reach them and no cue that anything had been lost. The environments
  now scroll in their own container, and "+", Theme and Settings sit in a
  pinned strip below it. "+" moved out of the scrolling list on purpose:
  creating an environment shouldn't mean scrolling past every environment you
  already have.

- **A multi-database connection stopped browsing after a few idle minutes,
  even though the tree still showed it as connected.** Expanding a database on
  a server-style connection (Postgres/MySQL/SQL Server with no fixed
  `database`) opens a synthetic per-database pool
  (`<parent>::db::<database>`), and since 1.13.0 an idle one of those is closed
  by the background reaper after `connections.childIdleTtlSecs` (default 5
  minutes) — deliberately, to stop a long session's connection footprint from
  only ever growing. What wasn't accounted for is that the _parent_ connection
  the tree actually reflects stays healthy the whole time (its own heartbeat
  keeps succeeding), so the tree kept reporting "connected" while the child
  pool the next click actually needed was already gone — surfacing as either a
  `not connected: <id>` error, or, when the click only triggered the column
  list, an indefinite loading skeleton (the store's `loadColumns`/`loadIndexes`
  had no error handling, so a rejected call just left it stuck). Every command
  that resolves a connection id now transparently reopens a reaped child pool
  first, with the same cached credentials it used the first time, before the
  usual lookup — the reap itself is unchanged, only its effect on the next
  click is. Read-only metadata calls (`list_tables`, `list_columns`, the
  keepalive ping, …) also gained a 20-second timeout, so a socket a NAT or
  firewall silently half-closed fails fast instead of hanging — previously the
  only timeout anywhere in the backend guarded pool shutdown, not queries. SQL
  Server needed one more fix underneath this: a query cancelled by that new
  timeout could otherwise be handed back to the pool as healthy with its TDS
  stream left mid-read: a session is now only returned to the idle pool once
  its result has actually been classified as leaving the stream at a clean
  boundary, never on a cancelled future.
- **The `huginndb-mcp` connector could fail an otherwise-successful call with
  `invalid input: empty reply`, most visibly against SQL Server.** The bug is
  in the local bridge the sidecar uses to reuse the desktop app's own pools:
  every tool call opens with an `EnsureConnected` round trip whose success
  value is `Value::Null`, and the wire format wrapped a reply's payload in a
  bare `Option<Value>` — which `serde_json` collapses to "absent" for _any_
  `null`, regardless of what it's wrapping. A legitimate `Value::Null` success
  was therefore indistinguishable from no reply at all. The bug is agnostic to
  driver — it can hit the first call of any tool against any connection while
  the bridge is active — but SQL Server was the one place it got noticed,
  likely because other drivers were exercised with the sidecar in its
  standalone (no-bridge) mode, where this code path never runs. The payload is
  now wrapped one level deeper so the wire can tell "a null value" from "no
  value" apart; the bridge's protocol version is bumped accordingly so an old
  sidecar a client kept alive across an app update degrades to its local-pool
  fallback instead of misparsing the new shape mid-call.

## [1.15.0] — 2026-08-14

### Added

- **Environments can carry a custom avatar image.** Until now an environment
  was always drawn as its initials over the accent colour, which stops
  disambiguating as soon as two of them start with the same letter ("Cliente A"
  / "Cliente B") — exactly the case the rail exists to make glanceable. The
  create/rename dialog now takes an image: pick one through the native file
  dialog, or drop a file straight onto the avatar preview. It replaces the
  initials in the rail, the workspace picker and the dialog preview, and the
  status-bar switcher shows it too instead of its colour dot (an image is
  recognisable at 12px, which is why initials never were there). Clearing it
  goes back to the initials tile.
  Where it is stored: inline in the existing `Environment.icon` field — a
  `data:` URL, so no backend schema change and no data migration. Whatever the
  user picks is centre-cropped square and re-encoded at 128px (WebP where the
  webview can encode it, PNG otherwise) before being stored, which keeps the
  payload in the low single-digit KB: `icon` round-trips through
  `tab_state.json` on every environment write, so a full-resolution photo there
  would bloat a file the app rewrites constantly. Keeping the image inline
  rather than as a file under the config dir means it has no lifecycle of its
  own — it is copied, discarded and written with the environment itself, so
  there are no orphans to sweep and no second failure mode where the JSON
  points at a file that is gone.
  `icon` is the slot the old lucide icon picker used to write, and an
  environment that still holds a legacy icon key falls back to the initials
  exactly as it has since that picker was removed: the image branch is gated on
  the value being a `data:image/` URL, not on the field being non-empty.
  One new backend command (`read_image_data_url`) does the reading, because the
  native picker hands back a _path_ the webview cannot open itself. It
  validates the format from the file's magic bytes rather than its extension
  and refuses anything over 12 MB, so an unusable file is rejected with a clear
  message instead of turning into a data URL no `<img>` will load. The drop
  path never touches it — the browser already has the bytes.

- **Linux release artifacts are now published.** Every release already _could_
  have shipped them: `tauri.conf.json`'s `bundle.targets` has listed `deb` and
  `appimage` since 1.7.0, and `.github/workflows/release.yml` carried both the
  `ubuntu-22.04` matrix leg and its apt build-deps
  (`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
  `patchelf`). The leg was just commented out, so nothing was ever built and
  Linux users had to compile from source — the README even said so. It is now
  enabled, and a tagged build attaches `x86_64` `.deb` + `.AppImage` next to
  the Windows installer, with a new "From a release (Linux)" section in the
  README covering both. `ubuntu-22.04` is a deliberate choice over
  `ubuntu-latest`: an AppImage links against the glibc of whatever machine
  built it, so building on a newer image would silently narrow the range of
  distros the artifact can start on. The matrix already sets
  `fail-fast: false`, so a Linux-leg failure cannot take the Windows artifacts
  down with it, and the `tauri-action` step gained `retryAttempts: 3` because
  two legs now publish updater artifacts to one release: the action merges
  each platform's entry into the existing `latest.json` rather than replacing
  the asset, so no entry is lost, but parallel legs can race on the delete —
  retrying the whole fetch-merge-upload is the upstream-intended mitigation.
  Not yet exercised by a real tagged run — the workflow's `workflow_dispatch`
  input builds a draft against a throwaway tag for exactly this kind of smoke
  test.

### Changed

- **The environment label in the left rail is a little larger.** It was 10px,
  which on a 1080p display sat below what the one piece of always-visible
  environment chrome should need to be read at a glance from the corner of the
  eye. Now 11px with tighter letter-spacing, so roughly the same number of
  characters still fits in the 72px rail before truncating, and the active
  environment's label is medium weight — "which environment am I in" now reads
  from the type as well as from the background tint.

### Fixed

- **The README pointed Windows users at a `.msi` that no longer exists.**
  Windows bundling moved from WiX/MSI to NSIS in 1.7.0 (see gotcha #21 in
  `CLAUDE.md` for why: WiX v3 was archived in February 2025 and its
  `light.exe` stopped running on GitHub's Windows runners at all), so releases
  have been shipping a `-setup.exe` for several versions while three places in
  the README — the download instruction, the SmartScreen note's SHA-256
  advice, and the tech-stack bundling line — still named the MSI. Anyone
  following the README looked for a file that isn't attached to the release.

- **Folding a connection group in one surface silently folded it everywhere else it was on screen.** `useConnectionGroupCollapse` (`src/lib/connection/useConnectionGroups.ts`) is shared by the File menu, the connections manager dialog, the status-bar switcher and the environment's Schema tree; in the default "remember" mode it read `prefs.ui.collapsedConnectionGroups` as a live Zustand selector, so every mounted instance re-rendered off the same value on every toggle. Opening the connections manager while an environment's tree already had a group open showed it open too (as expected — same remembered layout), but collapsing that group _inside the dialog_ also collapsed it live in the tree behind it, because both surfaces were really one shared instance of the fold state rather than independent views that merely started from the same saved arrangement. The hook now seeds a per-instance session override from the persisted set once, at mount, and every toggle — in all three expand modes, not just the forced "expanded"/"collapsed" ones — only touches that instance's local state; "remember" toggles still write through to disk so the _next_ surface to mount (including a future app launch) picks up the latest arrangement, but an already-open surface elsewhere is no longer reshaped out from under the user. No preference or on-disk schema changed.

- **The "Restart now" button gave no feedback after being clicked, inviting repeat clicks.** `installAndRelaunch` (`src/stores/update.ts`) went straight from `readyToRestart` to a transient `ready` right before `installUpdate()`/`relaunchApp()` — but everything in between (an async MCP-sidecar check, and its confirmation dialog if a client currently holds the sidecar) ran while the store still reported `readyToRestart`, so both `UpdateBanner` and the Settings → About updates card kept rendering the idle "Restart now" / "Install and relaunch" label with the button fully clickable. A new `installing` status is now set synchronously the instant the click handler runs, before any `await`; both components disable their install button and the banner's dismiss controls and swap in a spinner + "Restarting…" label for the whole gap. `installAndRelaunch` also short-circuits if it's called again while already `installing`/`ready`, so a stray double-invocation can't queue a second install even if a click slips through.

## [1.14.0] — 2026-08-13

### Added

- **The command palette (Ctrl/Cmd+K) is now a real launcher.** It used to index
  three things — the saved connections, the selected connection's tables, and a
  fixed handful of actions (new query, preferences, theme, language) — filtered
  with a plain substring `includes()`. It now indexes thirteen groups and ranks
  them:
  - **Every individual preference**, VS Code style: typing `#wrap` (or just
    `wrap`) finds "Soft-wrap long lines", shows its current value, and Enter
    opens Preferences on that section and scrolls to _that row_, flashing it.
    Boolean settings can also be flipped without leaving the palette with
    Alt+Enter, which keeps it open so the value badge updates under the cursor.
    Every rebindable shortcut is indexed the same way, with its current combo.
  - **The documentation** (each in-app doc, plus What's new, Report/suggest,
    Check for updates, About, the MCP setup page).
  - **Navigation**: open tabs (Enter jumps, Alt+Enter closes), saved
    connections (Alt+Enter disconnects a live one), environments, the databases
    of a multi-database server, tables and views across _every_ connected
    connection rather than only the selected one, saved queries and the last 20
    entries of the query history.
  - **Actions** that previously existed only in a menu: new/manage connection,
    import/export profiles, disconnect all, refresh schema, refresh the active
    table's data, close/pin the active tab, close all tabs, new window, reset
    layout, float the active panel, and a toggle per dock panel.

  Search itself changed shape: entries are scored rather than filtered
  (`src/lib/commandPalette/fuzzy.ts` — prefix beats word-start beats substring
  beats subsequence, with run-density and word-boundary bonuses and a
  shorter-is-better tiebreak), the characters that matched are emphasised in
  each row, groups are ordered by their best hit so section headers stay
  coherent, and the commands you actually use float to the top under a
  "Recently used" heading (persisted in `localStorage`).

  Mode prefixes narrow the search the way they do in VS Code — `>` actions,
  `@` tables, `#` settings, `?` help, `:` go to — shown as clickable chips
  while the field is empty and cyclable with Tab, so a connection with
  thousands of tables can't bury the actions.

- **`Ctrl/Cmd+Shift+P` opens the palette in actions-only mode** (VS Code
  parity). Rebindable like the rest, under Settings → Shortcuts.

- **The palette can index a multi-database server's tables on demand.** A
  server-wide connection starts with only its _database_ list loaded — each
  database's tables arrive under its own `<parent>::db::<name>` slice, and only
  once something opens that view — so a freshly connected server had databases
  to offer and no tables to search. `@` mode now also lists an "Index all
  databases of X" entry while any of them is still cold; running it opens those
  views three at a time and keeps the palette open so the tables land under the
  cursor. It is a deliberate action rather than an automatic fan-out on every
  keystroke because each view is another connection pool — same reasoning, and
  the same concurrency cap and connection-limit circuit breaker, as the schema
  explorer's cross-database search (`src/lib/commandPalette/warmSchema.ts`).
  The per-connection "databases to show" subset is honoured, so a database
  hidden in the tree stays hidden in the palette.

- **Import/export a theme from Settings → Appearance.** An export icon next
  to the theme editor's mode picker writes the active theme (built-in or
  custom) to a JSON file via the native save dialog; an import icon in the
  theme list's header reads one back as a brand-new custom theme (always a
  fresh id, never colliding with an existing one) and switches to it
  immediately, the same as duplicating a theme already does. The file format
  is a small versioned envelope (`src/lib/themeTransfer.ts`) — themes live
  entirely in the frontend's `localStorage`-backed store, so the only
  backend piece needed is a narrow `write_text_file` command mirroring the
  existing `read_text_file` used by SQL import.

- **A "Summer" built-in theme** — a light, warm palette (sun-bleached sand
  background, a single ocean-teal brand/ring accent, coral primary and
  destructive tones) joining the existing built-in set in
  `src/lib/themes.ts`.

- **Per-environment theme override.** The environment create/rename dialog
  (`EnvironmentEditorDialog`) gets a theme picker alongside the existing
  colour field, listing every built-in and custom theme plus a "Default"
  option. Assigning a theme to an environment applies it automatically
  whenever that environment is entered — at launch or on `switchTo` — and
  clearing it (the default option, always available) falls back to whatever
  theme is set in Settings → Appearance. The override is layered on top of
  the existing theme store (`useThemeStore.setEnvironmentOverride`) rather
  than overwriting the persisted default, so switching back to an
  environment with no override never loses the user's regular theme choice.
  Persisted on the backend as `Environment.themeId` (`tab_state.json` v4;
  `None` by default, so existing environments are unaffected).

- **Double-click a column's edge in the data grid to fit it to its content**
  (HeidiSQL's gesture). A value too long for the default width — a serialised
  widget config, a description paragraph — no longer has to be opened in the
  cell editor just to be read: the column grows to the widest value currently
  on screen and stays there (persisted per table, like a manual resize).
  Holding `Ctrl`/`Cmd` while double-clicking fits every column at once, and the
  handle's tooltip spells both gestures out. The grid's toolbar also gets a
  button for the fit-everything version, so it isn't only reachable through a
  gesture you have to know about — table tabs and query results alike.
  The fit is measured against the text as _rendered_ (BIT display mode, the
  NULL placeholder, the "truncate long text at" cap all apply) and capped at
  900 px, so one wide column can't push the rest of the row off-screen;
  dragging by hand still goes as wide as you like.

- **The grid's toolbar is responsive.** On a narrow pane it used to split into
  two rows, with the filter cluster on one and the action cluster on the other.
  Now the actions leave the bar instead: the toolbar measures its own width
  (it lives in a dock panel, so a media query would be measuring the wrong
  thing) and collapses in two steps — first the labelled data actions (insert,
  import, export, bulk update) move into a single `⋯` overflow menu, then, on a
  genuinely narrow pane, so does everything else, leaving the search box and
  the `⋯`. Active filter chips fold into one "2 filters" chip whose dropdown
  still removes them one at a time, and the row count / query time move into
  the menu rather than disappearing — except on a grid with nothing else to
  collapse (an ad-hoc query result), where they stay in the bar because there
  would be no menu to read them in.

- **The outer window shell is now activity-bar-driven instead of five equal
  dockview panels.** Schema, Saved, Console, the cell editor, and the
  workspace used to live as interchangeable dockview groups the user could
  drag, tab together, or float — which visually implied you could spin up
  more "workspaces," never the intent. Console now docks to the bottom with
  its own collapsible header; Saved collapses/expands from a button in a new
  right-hand activity bar; the cell editor is a plain flex split _inside_ the
  workspace island rather than a sibling dockview group (so opening/closing
  it can no longer trigger dockview's proportional-reflow-of-siblings side
  effect); and the workspace itself is a fixed, un-draggable "island" card
  with its own header, wrapping the open table/query tabs area unchanged.
  Every panel now animates open/closed (200ms ease, suspended during an
  active sash drag so resizing still tracks the pointer 1:1) instead of
  mounting/unmounting instantly. New VS Code-style toggle buttons in the
  header's top-right corner (`PanelLeft`/`PanelBottom`/`PanelRight` icons)
  show/hide Schema, Console, and Saved independently of the activity bars.
  Layout state moved to a small store (`stores/session/panelLayout.ts`,
  persisted separately from the old dockview blob) since dockview's panel
  API has no `setVisible` for a normal panel — there is no way to collapse
  one to 0px without removing it, which reflows its siblings. The nested
  dockview inside the workspace island (open table/query tabs, their own
  split/float geometry, drag-and-drop) is completely unaffected.

- **The left activity bar is now a Discord/Teams-style environment rail**
  instead of a single generic "Schema" button. Every environment gets its
  own avatar (initials over its accent colour, in a rounded square — see the
  next entry) with its name underneath; a trailing "+" opens the same
  create dialog the status-bar switcher already had. Clicking a
  non-active environment switches to it _and_ opens the Schema panel in one
  gesture; clicking the already-active one just collapses/expands Schema —
  there is no separate dedicated toggle button anymore since that would be
  redundant with it. Right-clicking an avatar opens the same rename/delete
  context menu the status-bar switcher's dropdown rows offer, so environment
  management doesn't require a trip down to the status bar. The status-bar
  switcher (`EnvironmentSwitcher`) is unchanged and still there — this is an
  additional, not a replacement, way to switch.

- **Environments render as a Teams-style initials avatar** — up to two
  letters derived from the name, over the environment's accent colour (a
  neutral fallback when none is set), foreground colour picked for contrast
  automatically. Replaces the old lucide icon picker in the environment
  create/rename dialog, which is gone; the dialog now shows a live avatar
  preview next to the name field instead. Used everywhere an environment is
  shown: the new rail, the empty-workspace environment picker cards, and the
  create/rename dialog's preview. The status-bar switcher deliberately keeps
  a plain colour dot instead — too small at that scale for initials to stay
  legible. `Environment.icon` is unread but kept on the wire (both in the
  store and in the backend's `tab_state.json` struct — no migration was
  needed) as the future home for a custom uploaded image, which is designed
  in but not yet built: the avatar component is structured so an `env.icon`-
  backed `<img>` branch can be added later, taking priority over the
  initials, without touching any call site.

### Changed

- **A workspace tab now shows the table's name instead of running out of room
  before it.** With tabs open across several connections, each one printed
  `connection · database · database.table` — the database twice — and the part
  that actually tells two tabs apart, the table, was the part that fell off the
  end. The database appears once now, and the label truncates by priority: the
  connection context (repeated on every tab of that connection, and already
  signalled by the driver badge) gives up its width first, the name keeps
  hers, separated by a hairline rather than one more `·` in a name full of
  them. Hovering a tab shows its full identity — qualified `schema.table` and
  the connection — after a shorter delay than a chrome button's, since on a
  truncated tab the tooltip is the only way to read the whole name.

- **Clipped tabs fade out instead of being cut**, the way an IDE's tab strip
  does — both a name too long for its tab and the tab straddling the edge of
  a strip with more tabs than fit, which used to be chopped mid-letter against
  a hard vertical wall. Each fade appears only where something really is cut
  off: a name that fits keeps its full tail, and a strip with room to spare
  keeps clean edges. The faded edge doubles as the cue that there are more
  tabs that way.

- **The tab strip's "∨" button looks like a button**: its own surface and
  border, on the strip's recessed backdrop. It no longer prints the number of
  hidden tabs beside the chevron — the chevron already means "there is more",
  the list itself shows how much, and the count only competed with the tab
  names next to it.

- **The tab overflow menu ("∨ N") is the tab strip stood on its side.** It
  re-uses each hidden tab's own tab component, so every row arrived with the
  strip's _horizontal_ geometry: a one-sided 7px margin, the strip's
  truncation width inside a popover with room to spare, and two scrollbars,
  one of them horizontal. The chips stay — same trench backdrop, same fill and
  elevation, so the popover reads as part of the same surface — but each is
  full-width now, with the name on one line and its connection under it, the
  active one marked by a left rail rather than a top cap, and the popover
  scrolls in one direction only.

- **Removed the "⊞ N" button from the tab strip.** It opened the modal tab
  switcher, two pixels from the "∨ N" overflow list that answers the same
  question in place. The dialog itself stays on `Ctrl`/`Cmd`+`P` (rebindable),
  which is still the only way to search every open tab by name.

### Fixed

- **Jumping to a tab or table of a per-database view left the workspace
  pointing somewhere else.** A tab of a multi-database server carries the
  synthetic `<parent>::db::<database>` connection id, but
  `useConnections.active` only ever holds top-level profile ids (`markConnected`
  runs in `connect()`; a database view is opened by `open_database_view`), and
  `App.tsx` clears `selectedConnectionId` whenever it isn't in that set. So
  selecting a child id was undone a render later and replaced by whichever pool
  came first — nondeterministically. Both the tab switcher (pre-existing) and the
  command palette's new table/tab entries now resolve the owning profile through
  `parentConnectionId`; the tab itself keeps the child id, which is what scopes
  its queries.

- A single click on a column's resize handle no longer rewrites that column's
  width in `prefs.json` with the value it already had.

- Closing a tab from the "∨ N" overflow list left a dead row behind, showing
  the tab's internal id where its name had been. dockview builds that popover
  once, at open time, and never rebuilds it, so it now closes along with the
  tab that was closed from it.

## [1.13.0] — 2026-08-12

### Added

- **Microsoft SQL Server driver** — the fifth engine, requested by users
  running HuginnDB against SQL Server. Connect (with SSH tunnel support),
  browse databases/schemas/tables/views/indexes with row counts and sizes,
  run T-SQL in the editor, page/sort/filter the grid, edit cells, insert and
  delete rows, bulk update, and the users/permissions panel. Named instances
  (`HOST\SQLEXPRESS`) are resolved through the SQL Browser, and a "trust
  server certificate" toggle — on by default — makes the self-signed
  certificates most on-premise instances present usable. On Windows builds the
  connection dialog also offers Windows (NTLM) authentication with an explicit
  `DOMAIN\user`; the mode is hidden elsewhere because the underlying driver
  only compiles it for Windows.
- Minimum supported server is **SQL Server 2012**: paging uses
  `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, which does not exist before that.
- The new engine is wired into the connection accounting below rather than
  sizing itself: `tiberius` has no pool, so HuginnDB's own session pool takes
  the same per-server grant every other driver takes, closes explicitly on
  disconnect instead of waiting for a drop, and releases sessions left idle
  for five minutes.
- **Settings → Connections** — a new preferences section for the connection
  pool: the ceiling for a connection and for a per-database view, how many
  database views one connection may keep open, how long an unused one survives,
  and the keepalive interval. It also shows, live, how many pools HuginnDB is
  currently holding, with a button to release the per-database ones. That
  visibility is half the point: `too many connections` is only actionable if
  you can see your own contribution to it.
- **Per-server connection budgets.** The unit of accounting is now the server
  endpoint, not the saved connection. `Max connections per server` is the whole
  allowance HuginnDB will spend against one host, shared by every connection and
  every database view that reaches it — so three connections pointing at the
  same Postgres box no longer get three independent allowances, which is exactly
  how the footprint managed to be unbounded. Two connections behind _different_
  SSH tunnels that both name `localhost:5432` are correctly treated as different
  servers; two connecting as different users are correctly treated as the same
  one, since the server's limit is global.
  When a server's allowance is spent, opening a database view **closes the view
  you used least recently on that same server** rather than failing — so
  browsing a twelve-database server under a ten-connection budget still works.
  If there is genuinely nothing to reclaim, the error names the budget and where
  to raise it instead of surfacing a driver string.
- **Per-connection limit** — connections now have a **Max connections for this
  server** field. Connection capacity is a fact about a _server_, so it lives on
  the connection: it travels with profile export/import, syncs through shared
  origins, and the `huginndb-mcp` sidecar honours it automatically because it
  reads the same `profiles.json`. Blank means "use the global preference".
- **`huginndb-mcp --max-connections <n>`** — pool ceiling per exposed
  connection for the headless connector, defaulting to `2`. See the new
  "Connection footprint" section in `docs/MCP.md`.
- **Pool sharing with the MCP connector** (Settings → Connections → _Share
  pools with the MCP connector_, off by default). With it on, a running
  `huginndb-mcp` sidecar stops opening its own pools and asks the desktop app to
  run its queries instead. The machine then has **one budget per server**
  however many MCP clients are configured — until now each spawned its own
  sidecar with its own pools, invisible to the app and to each other. Two
  further consequences worth the switch on their own: the connector's activity
  appears in the app's **Console live**, every browse and write as it happens
  rather than only in `mcp-audit.log` afterwards; and the app re-checks each
  connection's write policy itself, independently of the sidecar's own check.
  The transport is a loopback-only listener with a per-run token kept in a
  `0600` file next to `profiles.json`. When the app isn't running, or the
  setting is off, the connector behaves exactly as before.
- `docs/CONNECTION_POOLING_ANALYSIS.md` — the audit these changes come from:
  how the engine allocated connections, worst-case arithmetic, ranked findings,
  and the endpoint-centric architecture the remaining work is heading towards.
- **Editable list view.** The row-per-card list view is no longer read-only: it
  is now a document editor in the shape MongoDB Compass made familiar. Nested
  objects and arrays arrive **folded** and open on demand, each field is one
  numbered line with its type in the right gutter, and **double-clicking a value
  edits it in place** (Enter or blur commits, Esc cancels, ∅ writes NULL). The
  expand button escalates the field to the same Monaco editor the table view
  uses — modal or docked, following the existing `cellEditorMode` preference —
  which is how a whole sub-document is edited as JSON.
  On MongoDB the type gutter is a **picker**: choosing a type rewrites the field
  as that BSON type (the full Compass vocabulary — `Binary`, `UUID`, `Code`,
  `Timestamp`, `MinKey`/`MaxKey`, `BSONRegExp`, `BSONSymbol`, `Undefined` and
  the ones already supported), fields can be **added** (a `$set` on a new path,
  including inside a nested object or appended to an array) and **removed** (a
  new `unset_field` command issuing `$unset`, behind the destructive-action
  confirmation). A document's `_id` stays read-only: `$set` on it fails
  server-side, so offering the edit would only ever produce an error.
  Editing a **nested** field addresses it by its update path
  (`customData.format`, `tags.2`), so a value inside a sub-document is written
  without rewriting the document around it.
- **MongoDB results now carry their real BSON types.** `QueryResult` gained a
  `row_types` field: one type tree per cell, mirroring the value's structure
  (`bson_type_tree`). The display JSON is deliberately lossy — `Int32`, `Int64`
  and `Double` all arrive as JSON numbers, `ObjectId`, `Date` and `Decimal128`
  all as strings — so without it the list view would have had to guess a type
  from the value and would have rewritten a `Long` as an `Int` the first time
  anyone fixed a typo in an unrelated field. The SQL drivers leave it unset;
  their column types were never ambiguous.

### Changed

- **The list view works on every driver.** It shipped in 1.11.0 as a
  MongoDB-only rendering, but the problem it solves — a wide or nested row that
  scrolls sideways and flattens its nested values into one unreadable line — is
  not MongoDB's alone: a 40-column table, or a row with a big `jsonb` column,
  has exactly the same shape. The toolbar toggle is now offered for
  PostgreSQL/MySQL/SQLite too, values are editable there through the same
  `update_cell` path as the table view, and nested values inside a JSON column
  fold like a sub-document. The three affordances that only make sense for a
  document database — add field, delete field, change type — stay hidden for
  SQL, where a row's column set belongs to the table, not to the row.
- **The view-mode preference moved to Settings → Appearance**, into a new
  **Data view** group, and lost its MongoDB-specific wording. It sits next to
  the theme editor because it answers the same question ("what does this look
  like") rather than "how does the grid behave", and it now carries three
  list-view options: whether nested values start expanded, whether the type
  gutter is shown, and whether fields are numbered. The stored key
  (`grid.documentViewMode`) is unchanged, so an existing choice survives.
- **`connections.maxConnections` changed meaning** from "ceiling for a single
  pool" to "total for one server". Nothing was released with the old meaning, so
  no migration is needed; the default moved from 5 to 10 accordingly, since it
  now covers a connection plus its database views rather than one pool. A
  top-level connection asks for at most 5 of that allowance and deliberately
  leaves room for a database view, so pinning a tight budget on a connection
  can't make its own databases unopenable.

### Fixed

- **A narrow grid column no longer hides the field name in favour of its type.**
  The header lays the name and the data type on one line, and both were plain
  flex items — but only the name was allowed to shrink, because `truncate` is
  what lets a flex item go below its content width. So the first thing a column
  too narrow for its content threw away was the one part that identifies it: a
  `BOOLEAN` column rendered as a bare "BOOL", with nothing left of the name. The
  priority is now inverted — the type is clipped away first, down to nothing,
  and the name only starts eliding once the type is gone.
- **The column-header tooltip describes the field instead of advertising
  sort actions.** It now shows the full name (the thing a narrow column
  clips), the full type, primary/foreign key with the referenced
  `table.column`, nullability when the catalog knows it, and the current sort
  state — and it is translated, which it never was. The old text offered
  "Ctrl/Cmd+click to add a column", which read as an offer to _create_ a
  column: wrong, and alarming in a window that also runs DDL. Sorting stays
  discoverable through the arrow glyph on every header.

- **"Databases to show" no longer leaks between environments.** The subset was
  stored on the connection, and a connection is global — so restricting a shared
  test server to one client's database while inside a "Producción" environment
  also hid every other database from the environment that server actually
  belongs to. The picker now asks where the choice applies: **this environment**
  (the default) keeps it local, so the same connection can show every replica in
  one environment and a single database in another; **all environments** saves it
  on the connection as before, which is also the value that travels through
  profile export/import and shared origins. An environment without its own choice
  follows the connection's, so nothing changes until you pick otherwise, and
  existing subsets keep working untouched. A connection published by a shared
  origin is read-only, so only the local scope is offered for it — previously its
  databases could not be filtered at all without the next sync undoing it.
  Connections are deliberately **not** cloned per environment: that would
  duplicate credentials and keychain entries and open a second pool against one
  server. Only the view of them is scoped.
- **The connection tree's filters now survive with auto-reconnect off.** Which
  connections are shown, which rows are folded, and the new per-environment
  database subsets are restored when an environment is entered regardless of the
  _Reconnect on launch_ preference. They describe how an environment looks, not
  what it reopens; behind that gate, entering an environment with reconnect off
  left the previous one's filters on screen.
- **`too many connections` on shared servers.** HuginnDB's connection footprint
  was unbounded, invisible, and multiplied across processes it did not
  coordinate with — which on a database also serving a JetBrains data source, an
  application backend's pool and one or more MCP sidecars was frequently the
  straw that broke the server. Several things were wrong at once:
  - Browsing a multi-database server opened a **whole extra pool per database**,
    each with its own independent ceiling of five, and nothing ever closed them
    short of disconnecting the parent connection. A server with twelve databases
    was a ceiling of ~65 backends from a single window, held until the app
    closed. Per-database pools are now capped at **2** connections, limited to
    **8 open views** per connection (longest-unused closed first), and closed
    automatically after **5 minutes** unused. They reopen transparently on next
    use, so nothing is lost but the round trip.
  - The schema explorer's cross-database search fanned out `openDatabaseView`
    across **every** visible database at once — on a nineteen-database server, a
    single keystroke was nineteen simultaneous connection attempts. It now runs
    at most three at a time and drains as a queue.
  - The MongoDB client set no pool bound at all, inheriting the driver's default
    of **100 per host** — a 20x divergence from the SQL drivers, by omission. It
    now takes the same budget as everything else.
  - Pools were torn down by `Drop` rather than an awaited close, so a
    reconnect or an environment switch could transiently hold both the outgoing
    and incoming sessions. Disconnect (and every other teardown path) now closes
    gracefully, with a timeout so a dead server can't stall it.
  - `min_connections` / `idle_timeout` / `max_lifetime` / `acquire_timeout` were
    left to `sqlx`'s implicit defaults. They are now set explicitly, and the idle
    timeout shortened to 5 minutes so an untouched pool gives its sockets back.
  - "Test connection" opened a five-connection pool to run one `SELECT 1`. It
    now opens one, and closes it.
- **The MCP connector never released a pool** for the lifetime of its process —
  which is however long the MCP client keeps it, typically days. It now closes
  pools unused for five minutes and defaults to a ceiling of 2 rather than
  inheriting the desktop app's 5.
- **`too many connections` is now recognised as such** rather than surfacing as
  an opaque driver string: Postgres `53300`/`53400`, MySQL `1040`/`1203`, the
  MongoDB pool timeout, and our own pool's acquire timeout. The message reports
  how many pools HuginnDB itself is holding and notes that other clients on the
  machine share the server's limit; the search fan-out stops instead of
  re-firing against a server that is already refusing it, and offers to release
  idle pools and retry.
- **Editing a connection silently reset fields the dialog doesn't show.**
  `save_profile` replaces the whole record, and the dialog rebuilt it from form
  state only — so saving a connection wiped its MCP write policy back to
  read-only and dropped its visible-databases subset. The dialog now preserves
  the stored profile's fields it doesn't edit.
- The MCP connector's write-policy classifier treated two T-SQL statements as
  reads: `SELECT … INTO <table>` (which creates a table) and `EXEC`/`EXECUTE`
  (which can rename objects or run dynamic DDL). Both are now classified as
  DDL, so a `read-only` or `data`-tier connection refuses them.
- The MCP `list_connections` tool reported the driver from a `Debug`
  representation, so a MongoDB connection came back as `"mongo"` instead of the
  `"mongodb"` every other surface uses.

### Known limitations (SQL Server)

- The **structure editor is read-only**: columns, keys, indexes and foreign
  keys are shown, but applying changes needs a T-SQL DDL builder that isn't
  written yet. Renaming a table (`sp_rename`) and the **view editor** are
  unavailable for the same reason.
- **`.sql` export/import** is not available yet; it needs a T-SQL literal
  encoder and `IDENTITY_INSERT` handling.
- Integrated/SSPI authentication (log in as the current Windows user without
  typing credentials) and Entra ID tokens are not offered.
- A named instance cannot be combined with an SSH tunnel: the SQL Browser is a
  separate UDP service the tunnel doesn't forward. Tunnel the instance's own
  TCP port and leave the instance field empty.

## [1.12.1] — 2026-08-05

### Added

- **Bulk update** — update every row/document matching a filter in one
  round trip, for all four drivers. A new "Bulk update…" toolbar button
  opens a dialog that reuses the DataGrid's own advanced-filter condition
  builder for the match side, plus a column/field → value editor for the
  set side; a debounced preview shows the exact `UPDATE ... SET ... WHERE
...` (or `db.<collection>.updateMany(...)` for MongoDB) and how many
  rows currently match before anything runs. An empty filter is rejected
  unless explicitly acknowledged, so a blank condition can't silently turn
  into a full-table update.
- **Export/import controls moved into the DataGrid toolbar.** MongoDB's
  per-collection JSON export/import (previously only reachable from the
  schema tree's right-click menu) and new SQL equivalents now live next to
  the grid's "Insert" button: an "Export data" dropdown offers "export the
  full table/collection" or "export query results" (scoped to the grid's
  current advanced filter, unpaginated); MongoDB additionally gets an
  "Import JSON…" entry in the same cluster. A new bottom toolbar row holds
  pagination and row-zoom controls, separated from the header's data
  actions.
- **"Export database…" is now a proper dialog**, reachable from both a
  connection's own context menu (pick one or more databases, and — per
  database — which tables) and, in multi-DB mode, a specific database's own
  menu (locked to that one database). Everything checked is written to a
  single combined `.sql` file, with a "Data" mode choosing plain `INSERT`s
  or a delete-then-insert form that survives re-running the dump against a
  target that already has data. Replaces the old one-click, always-whole-
  database export.
- **"Import .sql…" is now a confirmation dialog** instead of a bare
  browser-native confirm: it shows the statement count up front and, for a
  multi-DB connection, lets you pick which database to run the file
  against (or run it as-is, for a file that already addresses its own
  database via `USE`/qualified names).
- **Structure editor: categorised type picker.** The column type combo is
  now grouped by category (Integers/Real/Text/Date & time/Binary/Other, one
  catalog per driver) with a separate length/precision field, plus MySQL
  unsigned/zerofill checkboxes — first pass of a broader HeidiSQL-style
  rework of table creation/editing.
- **Renaming a table from the structure editor** now works: the Name field
  is editable in edit mode again, and applying a rename updates the open
  tab's title (and any other open tab for that table) instead of leaving it
  showing the old name. The schema tree's existing quick-rename dialog got
  the same fix.

### Changed

- The schema tree's per-table (MongoDB) and per-schema (SQL) "Export…"/
  "Import…" context-menu entries were removed now that the DataGrid toolbar
  and the new connection-/database-level dialogs cover the same ground —
  the per-schema entries in particular were mislabelled (they exported the
  _whole database_, not the clicked schema). Connection-level and
  per-database export/import remain in the tree. The "(Beta)" suffix on
  "Export database…"/"Import .sql…" is gone.
- The structure editor's columns table was redesigned with the app's own
  bordered/zebra-striped grid look instead of a bare `<table>` of plain
  inputs, with a key icon marking the primary key.
- Dragging a table/query tab to split the workspace now shows a distinct
  highlight for "split in this direction" versus "add as a tab here"
  instead of one flat overlay, and sibling panels ease into their new size
  on drop instead of snapping.

### Fixed

- The structure editor's ALTER builder (Postgres/MySQL/SQLite) never emitted
  a table-level `RENAME TO`, even though it already handled column renames;
  the SQLite destructive rebuild path had the mirror bug in its `INSERT`/
  `DROP` source. Both fixed.
- The `rustfmt` CI job was failing on every run (not flaky) because of an
  unformatted line left over from an earlier commit.

## [1.12.0] — 2026-08-03

### Added

- **Environments** — a new level above connections: a named set of
  connections plus its own tabs, pane layout and reconnect behaviour,
  switchable from a topbar selector (#109).
- **Shared origins** — sync an environment's connections (and passwords)
  from a shared config file, so joining a team means entering a passphrase
  once instead of configuring every connection by hand (#108).
- **Connections now live in the schema tree**, as its top two levels above
  folders; a connection's actions moved to its right-click menu (#107).
- **A searchable, tabbed workspace picker** (connections and environments)
  replaces the old empty-workspace placeholder (#110).
- **Table tabs remember their filters, sort and search** across a session
  restore (#112).
- **Filter by the selected rows** — right-click a column with rows selected
  to add a server-side `IN`/`NOT IN` filter (#114).
- **Redesigned query run feedback**: a live run timer, a 75/25 editor/
  results split by default, and a searchable history sidebar with
  per-entry "run again."
- **Neon**, a new near-black dark theme with a signature neon accent
  palette.
- Open table/query tabs now use the app's "island view" look, with a
  permanent per-tab driver-logo badge.
- Data-grid columns now show a visible divider, size themselves by type
  (booleans/numbers/dates/UUIDs get a sensible width from the start), and
  resize with a real live preview instead of a static guideline.

### Changed

- "Go to referenced row" moved from Ctrl/Cmd+click to Alt+click, freeing
  that chord for row multi-selection (#113).
- The global status bar no longer duplicates the query editor's own row
  count, timer or read-only badge.

### Fixed

- Several environment-switch bugs that could lose open tabs, focus or
  split layout, or silently collapse a split back into one tabbed group.
- A `SELECT` preceded by a comment ran correctly but showed no rows.
- Ctrl/Cmd+click now reliably toggles row selection, including on tables
  without a primary key (#113).
- Long dropdown/context menus now scroll instead of clipping (#111).
- Fixed the MySQL/Postgres table-browsing regression from 1.11.0's
  row-count split: the count no longer competes with the data fetch for a
  pooled connection.
- Driver logos and the theme swatch are now theme-aware instead of sitting
  on a fixed light tile.

### Performance

- Clicking a row/cell in the data grid, and opening a new tab alongside
  several already-open ones, no longer re-renders every other row/tab —
  both previously scaled with the total row/tab count.

## [1.11.0] — 2026-07-24

### Added

- **MongoDB list view.** Collection tabs for a `mongodb` connection now offer
  a table/list toggle in the toolbar (only shown for that driver — every
  other driver keeps rendering as a table). List mode renders each document
  as a card with one `field: value` line per top-level column instead of one
  column per field, which was the actual pain point: a document with many
  fields, or with a nested object/array value, forced constant horizontal
  scrolling in table mode and flattened the nested value into a single-line
  JSON blob that was hard to read. List mode pretty-prints nested
  objects/arrays with indentation instead. It's deliberately read-only for
  this first pass — no inline cell editing, no insert/duplicate draft row —
  since those need the table's editable-row UI; per-row "Copy as JSON" and
  "Delete" still work directly from the card, since neither needs it. The
  chosen mode is a single global preference (`grid.documentViewMode` in
  `prefs.json`, also exposed in Settings → Grid), not per-collection — same
  tier as `rowHeight` or `bitDisplay` — so switching once applies to every
  MongoDB collection you open afterwards.

- **Reconnect on launch.** A new General preference (default on) makes the
  main window automatically reconnect, at startup, to the connections that
  were live when it was last closed — using the credentials already in the
  OS keychain. Previously the app opened disconnected and you had to
  reconnect to each host by hand (and, because of the layout bug below, in
  the _right order_) to get your workspace back. Connections whose password
  isn't stored, or whose host is unreachable, are skipped without blocking
  startup; the toggle lets you opt out entirely. The launch state — which
  connections were live, which one was focused, and which tab was active — is
  persisted on graceful close and opportunistically on each
  connect/disconnect, so the workspace comes back the way you left it (same
  connection in focus, same tab, same pane layout) regardless of the order the
  pools happen to reopen, and even an abrupt exit leaves something to restore.

- **Canary build channel.** A new opt-in pre-release channel lets a change be
  dogfooded against real production connection profiles _before_ it ships in a
  stable release — no full release required. A canary build (compiled with the
  new `canary` Cargo feature, paired with `src-tauri/tauri.canary.conf.json`)
  installs side-by-side with the stable app: it has its own bundle identifier
  (`io.huginndb.canary`), product name ("HuginnDB Canary"), and a separate
  auto-updater feed, and it isolates all of its on-disk state into a dedicated
  `HuginnDB-Canary` config directory. That isolation means a canary can safely
  exercise destructive, one-way on-disk migrations without ever touching the
  stable install's `profiles.json` / `tab_state.json` / `prefs.json`. The OS
  keychain service is deliberately _shared_, so the canary reuses the passwords
  the stable build already stored rather than forcing them to be re-entered.
  Builds are produced by a manual `canary` GitHub Actions workflow from any
  branch or commit and published to a single rolling `canary` release; see
  `docs/CANARY.md`.

- **Sandbox indicator for the canary build.** Because the canary shares the UI
  bundle (and the OS keychain) with the stable app, once you were _inside_ the
  window the two were indistinguishable — easy to mistake the sandbox for your
  real install. The canary build now makes its identity unmistakable: a
  persistent amber "SANDBOX · HuginnDB Canary" ribbon pinned above the header
  (with the isolated state dir called out), a "CANARY" badge next to the
  header brand, a flavor-aware OS window title ("HuginnDB Canary" in the
  taskbar / Alt-Tab, which the frontend previously overwrote back to
  "HuginnDB"), and an About panel that shows the canary product name and its
  real `HuginnDB-Canary` state paths. The stable build is visually unchanged.
  A new `get_app_flavor` command exposes the compile-time `canary` feature to
  the frontend, since the two builds ship an identical JS bundle.

### Changed

- **The row-count no longer blocks the first rows from appearing, and a
  whole-table count is now an instant estimate.** Opening a table/collection
  used to compute the data page _and_ an exact `COUNT(*)` (`count_documents`
  on MongoDB) in a single round trip, returning nothing to the grid until
  both finished. On a multi-million-row table the count dominated, so the
  first paint waited seconds on a query whose 100 rows were already in hand —
  exactly the "Compass feels faster" report in issue #77. The count is now a
  separate request (`count_table_rows`) fired alongside the data fetch: rows
  render as soon as the `SELECT`/`find` returns, and the pagination range
  fills in the total when the count arrives (paging still works in the
  meantime). For a whole-table browse (no filters, no search) the total comes
  from the engine's O(1) statistics — `pg_class.reltuples` on Postgres,
  `information_schema.TABLE_ROWS` on MySQL, `estimatedDocumentCount` on
  MongoDB — and is shown as an approximate `~N` (hover for the tooltip). A
  never-analysed table (or SQLite, which has no cheap estimate) falls back to
  an exact count. Any active filter/search forces an exact count of the
  matching subset, but it still runs off the render's critical path. The
  headless `huginndb-mcp` `browse_table` tool is unchanged (it keeps the
  inline exact count).

- **Table-tab toolbar consolidated into a single bar (MongoDB Compass-style).**
  The top toolbar of a table/collection tab previously crowded four different
  concerns into its left edge — the reload button, the advanced-filter button,
  the MongoDB table/list view toggle, and a cramped fixed-width (`w-56`) search
  box — while a _second_ bottom status strip carried the row zoom and the
  pagination controls. Worse, the row total was shown twice: "37 rows of 37"
  top-right and "1–37 / 37" bottom-right. Everything now lives in one bar:
  - **Left (actions):** refresh · advanced filter · the search box — which is
    now the visual anchor, growing to fill the available width (capped, with a
    leading magnifier icon) instead of the old narrow fixed size — and the
    **Insert** button right beside it, since inserting is the other primary
    action on the row set.
  - **Right (display), pinned via `ml-auto`:** a single human-format
    pagination range (`1–100 of 19759`, replacing the old duplicated count and
    the slash form) · prev/next page buttons · the page-size selector · the
    row-zoom −/+ pair (lifted up from the deleted bottom strip) · the MongoDB
    view toggle (Mongo-only) · elapsed time.

  The bottom status strip is gone entirely, giving the grid more vertical room.
  Wired through a new `toolbarTrailing` slot on `DataGrid` (mirroring the
  existing `toolbarLeading`) plus a `showRowCount` prop: table tabs pass
  `false` because the pagination range supersedes the count, while query/view
  result tabs — which don't paginate — keep the built-in "N rows of M" as their
  only row-total indicator. No data behaviour changed; same actions, same
  keyboard shortcuts, purely a layout/affordance pass.

- **The workspace pane layout is now session-level, not per-connection.**
  The inner-dockview split/float geometry (how you've arranged the open
  table/query tabs) used to be stored redundantly under _every_ connection
  in `tab_state.json`, even though a single inner dockview hosts all
  connections' tabs at once. On restore, whichever connection you happened
  to connect to first won — so the layout only came back if you reconnected
  in a specific order. It's now stored once at the top level of
  `tab_state.json` and restored a single time at launch, independent of
  connection order. Existing per-connection layouts are migrated
  automatically on first load after upgrading (the most-recently-used one is
  promoted to the session layout), so nobody loses their arrangement.

- **"Float in new window" now opens a real, independent OS window.** A tab's
  "Sacar a ventana flotante" action used to call dockview's
  `addFloatingGroup`, which only detaches the panel _within_ the inner
  workspace's own bounds — the floating panel could be dragged around, but
  never past the edges of the workspace pane it came from, which defeated the
  point when you wanted, say, the cell editor free of the table view
  entirely. It now opens a bare, native `WebviewWindow` (`open_tab_window`,
  rendered by the new `DetachedTabWindow` root) that hosts just that one
  tab — no sidebar, no other tabs, no menus — and can be moved anywhere on
  the desktop like any other window. The tab is removed from the main
  window's workspace the moment it's popped out, so closing the detached
  window is simply the tab's close: there's no state to reconcile back.
  Applies to every tab kind (table, query, structure, view, security). Like
  "New window", these windows are ephemeral — they don't touch
  `tab_state.json` and aren't restored across restarts.

### Fixed

- **Double-clicking a cell's text no longer fails to enter inline-edit
  mode.** Since the "expand" icon landed (#78), a selected cell also grows a
  `ring-2 ring-inset ring-brand` border on the `<td>` itself, occupying the
  cell's edge/padding area alongside the value. On the Linux WebKitGTK
  webview, double-clicking directly over the value's text intermittently
  never fired the native `dblclick` event at all — a known WebKitGTK quirk
  where `user-select: none` (set table-wide, see `DataGrid.tsx`'s
  `select-none` note) suppresses `dblclick` specifically when there's
  selectable text under the pointer, while double-clicking the cell's empty
  padding (no text glyph under the cursor, which is what made it _look_
  like clicking "the border" was the trick) worked fine. The `<td>`'s
  `onClick` handler now also checks the native `click` event's own
  `detail` (the OS click count, unaffected by that quirk): a second click
  (`e.detail >= 2`) routes straight into `openCellEdit`, the same path
  `onDoubleClick` already used — so edit mode now opens reliably regardless
  of exactly where in the cell the double-click lands.

- **Typing into an inline cell edit no longer kicks the caret to the end
  of the value on every keystroke.** `DataGrid`'s `columns` memo listed
  `inlineEdit` (and `fkEditCell`/`selectedCell`) in its dependency array, so
  every keystroke — which updates `inlineEdit.value` — rebuilt the entire
  `columns` array, handing every column's `cell` renderer a brand-new arrow
  function reference. TanStack's `flexRender` treats `columnDef.cell` as a
  component _type_ (`typeof Comp === "function"` → `React.createElement(Comp,
props)`), so a new reference each render reads to React as a different
  element type for every cell in the grid — forcing a full unmount +
  remount of the whole table body, including whatever `<input>` was mid-edit.
  A freshly-mounted `autoFocus` input always plants its caret at the end,
  which is exactly what made moving the cursor mid-value and continuing to
  type impossible without retyping the whole thing. `fkEditCell`/
  `inlineEdit`/`selectedCell` are now mirrored into a `useRef` updated on
  every render instead of being memo dependencies; each column's `cell`
  function reads the live values off that ref, so its own identity — and the
  mounted DOM underneath it — stays stable across keystrokes.

- **Secondary windows ("New window") can now rearrange their panels.**
  Dragging a panel in a window opened via the Window menu always showed the
  "not-allowed" cursor: the window was built without the main window's
  `dragDropEnabled: false` setting, so Tauri's OS-level drag-drop handler
  stayed on and swallowed the HTML5 drag events dockview relies on. The
  secondary-window builder now disables that native handler, matching the
  main window exactly.

## [1.10.0] — 2026-07-23

### Added

- **Views can now be created, edited, renamed and dropped from the schema
  explorer (#86).** Until now a view showed up in the tree read-only —
  its context menu offered only Open / Copy name / Copy SELECT / Refresh,
  with every DDL action explicitly gated off (`!isView` in
  `SchemaExplorer.tsx`), and the backend had no query to even read a view's
  definition (`pg_get_viewdef` / `information_schema.views` /
  `sqlite_master.sql` were never called). The only way to touch a view was
  to hand-write `CREATE OR REPLACE VIEW` in the query editor — exactly the
  HeidiSQL-style raw-SQL experience the maintainer wanted to avoid,
  especially for views with several JOINs where it's hard to tell what
  columns/rows the definition actually produces just by reading the SQL.
  Rather than build a full visual join/query builder (roadmap item 9,
  explicitly low priority), the new "Edit view…" tab pairs a full-size
  Monaco SQL editor for the view body — with the same schema-aware
  autocomplete as the query editor — with a live, debounced "preview
  results" grid that runs the current draft (wrapped in a `LIMIT`-ed outer
  `SELECT`) so the actual columns and rows a JOIN produces are visible
  while typing, plus a read-only DDL pane (same pattern as the table
  structure editor) showing the exact statements Apply will run. New
  backend module `db/view_ddl.rs` builds driver-aware DDL from a diffed
  `ViewDefinition`: `CREATE OR REPLACE VIEW` on Postgres/MySQL (with an
  explicit `ALTER VIEW … RENAME TO` / `RENAME TABLE` first when the name
  changed), and always drop+recreate on SQLite (no `CREATE OR REPLACE
VIEW` / `ALTER VIEW` there) — informational only in the UI, since a view
  holds no data of its own to lose. Five new Tauri commands
  (`get_view_definition`, `preview_view_change`, `apply_view_change`,
  `rename_view`, `drop_view`) mirror the existing
  `get_table_structure`/`preview_structure_change`/`apply_structure_change`
  shape. MongoDB is excluded in this version, same as table-structure
  editing — its "views" are read-only aggregation-pipeline collections
  with a fundamentally different edit model (`collMod`/`createView`).
- **A `between` operator in the Advanced Filter, unifying range filtering across
  every driver (#81).** The advanced-filter builder already offered
  `contains`/`not_contains`/`starts_with`/`ends_with` consistently on Postgres,
  MySQL, SQLite and MongoDB (verified while investigating this issue — MySQL's
  `contains` was already working via the shared `CAST(col AS CHAR) LIKE`
  path), but no operator existed to filter an inclusive range in one
  condition; a user had to stack a `gt`/`gte` row and a `lt`/`lte` row instead.
  `FilterOp::Between` is now a single shared variant consumed by
  `build_filter_clause` (SQL: `col BETWEEN ? AND ?` / `BETWEEN $N AND $N+1`)
  and Mongo's `build_filter` (`{ $gte, $lte }`), backed by a new `value2`
  field on `ColumnFilter` (added on both the Rust struct and its TypeScript
  mirror — a value dropped silently by serde otherwise, see gotcha #14). The
  dialog offers it alongside `gt`/`gte`/`lt`/`lte` for numeric/date columns
  and renders a second "to" input when selected.

- **A single click now shows a direct "expand" icon on the selected cell,
  so its full value can be viewed without first double-clicking into edit
  mode (#78).** Previously the only way to view a long cell's untruncated
  content was to double-click, which for an editable cell also entered
  inline-edit mode — an unwanted side effect when the user only wanted to
  _read_ the value. The `DataGrid` cell renderer's plain (non-editing)
  branch now checks whether the cell matches `selectedCell` (set on plain
  single click, compared by the same `rowValues`/`row.original` referential
  identity used everywhere else in the grid — see gotcha #7) and, if so,
  renders a small `Maximize2` button next to the value. Clicking it calls
  the existing `openHeavyEditor`, unchanged, so it already honours the
  user's `cellEditorMode` preference (modal vs. docked side panel) exactly
  like the inline editor's own expand button and the cell-preview panel's
  fullscreen button do. The icon appears uniformly for text, FK and BIT
  columns, and for read-only query results — it is purely a value viewer,
  never an editor, so no column type needs excluding.

- **Ctrl+C / Ctrl+V now work on the selected data-grid cell (#79).**
  `handleGridKeyDown` used to deliberately ignore every Ctrl/Cmd-modified
  key chord (to avoid interfering with the browser's own copy/paste), which
  meant Ctrl+C over a cell copied nothing, since a `<td>` has no native text
  selection to copy from. Ctrl+C and Ctrl+V are now special-cased ahead of
  that blanket guard: Ctrl+C copies the raw value of the mouse-selected cell
  (falling back to the keyboard-navigated active cell when nothing has been
  clicked) via the same `copyToClipboard` helper the right-click "Copy"
  context-menu item already uses. Ctrl+V reads `navigator.clipboard`, and
  seeds `inlineEdit` with the pasted text instead of the cell's current
  value — reusing the exact same `CellInput` commit/cancel flow as a normal
  double-click edit, so Enter/blur saves the pasted value and Escape
  discards it. FK and BIT columns have no free-text control to paste into
  (they use a combobox / `<select>` instead), so paste is a deliberate
  no-op there for now; copy still works on every column type.

- **Keyboard shortcuts are now customizable from Settings → Shortcuts
  (#75), unblocking the hotkey half of #78.** Issue #78 asked for a hotkey
  alternative to the expand-icon added above, since the icon's low contrast
  makes it easy to miss — but explicitly deferred that to #75 first. Six
  actions are now rebindable: `openSettings` (Ctrl/Cmd+,),
  `toggleCommandPalette` (Ctrl/Cmd+K), `toggleTabSwitcher` (Ctrl/Cmd+P),
  `refreshData` (F5 — Ctrl/Cmd+R remains a permanent, non-rebindable alias,
  since suppressing the WebView's native reload is a safety necessity, not
  a preference), `runQuery` (Ctrl+Enter), and the new `expandSelectedCell`
  (default `Space`, mirroring macOS Quick Look — confirmed unbound in
  `handleGridKeyDown` today, so it lands with zero collision). Overrides
  persist through `prefs.json` as a new `keybindings` map (action id →
  combo string), following the exact pattern already used by `grid`/`editor`/
  `ui` prefs — an empty map is a fully valid state, since the frontend's new
  `ACTIONS` table in `lib/keybindings.ts` is the single source of truth for
  defaults. `App.tsx`'s global `keydown` listener and `DataGrid`'s
  `handleGridKeyDown` now match against the live binding via a shared
  `matchesBinding` helper instead of hardcoded `e.key`/`e.ctrlKey` checks —
  which incidentally fixes a latent bug where `Ctrl+Shift+K` was
  indistinguishable from plain `Ctrl+K` (no branch checked `shiftKey`).
  Monaco's `editor.addCommand`, used for `runQuery`/`toggleCommandPalette`/
  `toggleTabSwitcher` inside the SQL and view editors, resolves a fixed
  keybinding bitmask once at registration time with no way to re-check a
  live combo — so those three moved to `editor.onKeyDown`
  (`registerEditorActionRedispatch` in the new `lib/monacoKeybindings.ts`),
  which reads the current binding from the store on every keystroke. The
  Settings UI (`ShortcutsSection`/new `ShortcutRow`) replaces the old
  read-only placeholder: clicking a row enters a "press a key…" capture
  mode (Escape always cancels rather than becoming the binding), a rebind
  that collides with another action's combo is rejected inline instead of
  silently swapping or unbinding anything, and each row plus a "Reset all"
  button can restore the default. `expandSelectedCell` reuses the exact
  same `resolveTargetCell()`/`openHeavyEditor()` pair the expand icon's
  click handler already calls, so the icon and the hotkey converge on one
  escalation path. Also bumped both expand icons'
  (`DataGrid`/`CellInput`) contrast from `text-muted-foreground/50` to
  `/80` so the icon added in #78 doesn't require a hover to notice.

### Fixed

- **MySQL spatial columns (`POINT`, `MULTIPOINT`, …) were misclassified as
  numeric by the Advanced Filter**, because `isNumericType`'s substring check
  for `"int"` also matches inside the word `"point"`. Those columns lost
  `contains`/`starts_with`/`ends_with` and gained meaningless `>`/`<`
  comparisons. Found while auditing operator unification for #81; fixed by
  excluding the `"point"` substring from the `"int"` check.

- **The MCP connector's write tools could be forced into read-only for a
  MongoDB database they had explicit `data`/`full` access to.** Reported by a
  user hitting `has MCP write policy "read-only"` on `update_cell` against a
  connection whose Settings → MCP level was actually `data`. The write gate
  (`Huginn::require_class`) was checking the policy against
  `resolve_mongo_target`'s _resolved_ pool id rather than the real profile id.
  For a multi-database Mongo connection (empty top-level `database` — the
  common case, since HuginnDB doesn't require picking one at connect time), a
  tool call naming a `schema`/`database` resolves to the synthetic
  per-database id `<connection_id>::db::<name>` so it can address the right
  live pool — but that synthetic id is never a key in `profiles.json`, so the
  policy lookup silently missed and fell back to the default `ReadOnly`,
  regardless of what the connection was actually configured to. `run_query`,
  `insert_row`, `update_cell` and `delete_rows` now gate on `a.connection_id`
  (the real profile id) instead of the resolved target; the resolved target
  is still used, as before, to find the right pool. Added a regression test
  reproducing the exact scenario (a `data`-policy Mongo connection with no
  default database, addressed via `schema`).

- **`updateMany`/`updateOne` rejected an aggregation-pipeline update
  (`db.coll.updateMany(filter, [{ $set: {...} }])`)** with `argument 2 must be
a document`, even though the underlying `mongodb` driver has supported
  pipeline-style updates since server 4.2. The mongosh-style parser
  (`db/mongo/shell.rs`) only ever built a plain `Document` for the `update`
  argument. It now accepts either shape — a new `UpdateSpec` enum
  (`Document` | `Pipeline`) mirroring `mongodb::options::UpdateModifications`
  — so pipeline updates (e.g. `$replaceAll`/`$toUpper`/computed field values
  that reference other fields) work through `run_query` the same as they do
  in `mongosh`.

### Security

- **Manually verified the MCP connector's write-policy gate end-to-end
  against a real profile set, using an actual AI client (Claude Code driving
  `huginndb-mcp`) rather than a unit test.** `list_connections` was called
  first, read-only (no state touched): of every exposed connection —
  production databases and real client sandboxes included — exactly one
  (an internal ITBacking test server) carried `mcp_write: "data"`; every
  other connection sat at the safe `read-only` default, exactly as
  `McpWritePolicy::default()` (`state.rs`) guarantees for any profile that
  never had a level explicitly raised in Settings → MCP. An `insert_row`
  call was then attempted against that one `data`-policy connection, on a
  connection-less config table (no customer data, no foreign keys) — the
  lowest-risk target available — as a full round-trip check (insert, verify,
  update, delete, leaving no residue). The write never reached
  `Huginn::require_class`: Claude Code's own tool-permission layer (the
  client driving the MCP session, not code in this repo) intercepted the
  call and withheld it pending explicit user authorization, even though the
  server-side policy would have allowed it. This confirms the two gates are
  independent and both intact — a permissive per-connection `mcp_write`
  policy is necessary but not sufficient; the calling AI client's own
  action-approval prompt is a second, separate backstop, not a
  redundant/interchangeable one. No code changes resulted; this is a release
  checklist entry, not a fix.

## [1.9.1] — 2026-07-22

### Fixed

- **Running a single INSERT/UPDATE/DELETE showed no feedback (#82).** The
  query editor's single-statement path (`Ctrl+Enter`) rendered a columns-less
  DML result straight into `DataGrid`, which has nothing to draw for it — the
  results panel just looked empty, with no error and no row count. Only the
  multi-statement batch path ever showed a "rows affected" summary. A DML
  result (no columns) now shows a small "N rows affected · Xms" banner
  instead, on every SQL driver — this wasn't actually MySQL-specific, just
  more likely to be noticed there.

- **The MCP connector's write tools could make new client sessions see zero
  tools (#83).** The write-mode tools added for `insert_row`, `update_cell`
  and `delete_rows` introduced JSON-schema shapes never used before in this
  server's `tools/list` output: a nested struct hoisted into `$defs`/`$ref`,
  and PK-value fields whose per-item schema was the bare boolean `true`
  (schemars' representation of "any JSON value"). Both are valid JSON Schema,
  but an MCP client whose `tools/list` ingestion assumes every schema node is
  a plain object can throw on them — and if that ingestion wraps the whole
  tool list in one try/catch, a single malformed-for-that-client schema
  silently drops all 12 tools for the session, while the server's own log
  (which only reflects what it sent) looks perfectly healthy. The three
  tools' schemas are now inlined and hand-constrained to
  `string | number | boolean | null`, with a regression test asserting no
  `$ref`/`$defs`/bare-boolean subschema ever reappears.

- **Expanding a same-named database under a different connection could leak
  the previous connection's data (#76).** The multi-database schema tree
  keyed its `DatabaseRoot` nodes by database name alone; because nothing
  remounts that tree when the active connection changes, React reused the
  same component instance — and its locally-cached pool id — for two
  different connections that both happened to expose a database with the
  same name (e.g. a `shop` database on both a MySQL and a MongoDB profile).
  The second connection's node kept rendering the first connection's tables.
  The node is now keyed by connection + database name together, so switching
  connections always gets a fresh instance.

- **Window/split layout and in-progress tab edits could be lost on close
  (#80).** No window-close hook ever flushed the debounced tab/layout state
  to disk, and a pure split/float/resize gesture didn't schedule a save at
  all (only a tab or schema change did) — so a normal window close, not just
  a crash, could drop the last ~600ms of edits, including split-panel
  geometry set up moments earlier. Closing the main window now flushes every
  active connection's tab state synchronously first, and layout changes
  schedule a save the same way tab changes already did.

- **MongoDB activity never reached the Console.** Browsing a collection
  (`fetch_table_data`) and running a multi-statement mongosh batch
  (`execute_batch`) both delegated straight to the Mongo driver module
  without ever building a log entry — unlike the single-statement path,
  insert/update/delete, which already logged correctly. Every other driver
  logged every read and write; MongoDB only logged writes issued one
  statement at a time. Collection browsing now logs a reconstructed
  `db.<collection>.find(filter).sort().skip().limit()` line (there's no
  literal statement to echo the way a hand-typed one has), and each
  statement in a mongosh batch logs individually, same as the SQL batch path.

- **The advanced filter builder silently returned nothing on MongoDB when
  filtering a numeric (or boolean) field.** The right-click "Filter by this
  value" chip sends the cell's already-typed value (e.g. the JS number
  `183`), but the advanced-filter dialog's value input is a plain text box —
  it always sent the typed-in text as a JSON string. Postgres/MySQL/SQLite
  don't notice: an unbound parameter's type is inferred from the column it's
  compared against, so a text `"183"` still matches an `integer` column.
  MongoDB's equality is exact-BSON-type, though, and a `string` `"183"`
  never matches a stored `int32` 183 — so the identical filter that worked
  from the context menu returned zero rows from the dialog. The dialog now
  coerces the typed value to a number/boolean based on the column's type
  before applying the filter (substring-match operators — contains/starts
  with/ends with — keep the raw text, since those are always a text/regex
  match regardless of column type).

## [1.9.0] — 2026-07-20

### Fixed

- **Console logs leaked across windows (#50).** With a second window open (the
  "New window" action), every window's Console showed every other window's
  SQL and connection entries. The backend already targeted log events at the
  originating window, but the frontend listener wasn't scoped, so Tauri
  delivered all of them to every window. Each window's Console now shows only
  its own activity; genuinely global notices (like a shared connection dropping)
  still reach every window.

- **MySQL boolean columns showed `NULL` instead of their value (#68).** A
  `TINYINT(1)` / `BOOL` / `BOOLEAN` column is reported by the driver under the
  type name `BOOLEAN`, which the value decoder didn't recognise as an integer —
  so every boolean cell fell through to a text decode that isn't valid for the
  column and collapsed to `NULL`. Boolean columns now render their stored value
  (`0` / `1`), like any other integer.

### Added

- **Advanced per-column filter (#66).** A new filter button in the data-grid
  toolbar opens a builder where you add conditions per column — column →
  operator → value — all combined with AND and applied server-side. Operators
  are type-aware: text columns offer contains / does-not-contain / starts-with
  / ends-with, numeric and date columns offer ordered comparisons
  (>, ≥, <, ≤), and every column offers equals / not-equals / is-null /
  is-not-null. Works across Postgres, MySQL, SQLite (SQL `LIKE`/comparisons)
  and MongoDB (regex / `$gt`…`$lt`). The button shows a badge with the active
  condition count.

- **Empty a table from the schema explorer (#69).** A new "Empty table" entry
  in a table's (or MongoDB collection's) context menu removes every row while
  keeping the table and its structure — handy for tables used as logs. It uses
  `TRUNCATE` on Postgres/MySQL, `DELETE FROM` on SQLite, and `deleteMany({})`
  on MongoDB. A confirmation dialog guards the action and carries a "don't ask
  again" checkbox backed by a dedicated `confirmEmptyTable` preference, so
  silencing it never weakens other destructive confirmations.

- **MCP connector write-mode, with a per-connection permission model.** The
  headless `huginndb-mcp` connector, read-only since 1.7.0, can now perform
  writes — governed per connection, not by a single global switch. Each
  connection carries a **write policy** set in Settings → MCP:
  - `read-only` (default) — only reads succeed;
  - `data` — adds row-level DML (`INSERT`/`UPDATE`/`DELETE`) via `run_query`
    plus the new `insert_row` / `update_cell` / `delete_rows` tools;
  - `full` — also allows DDL (`CREATE`/`DROP`/`ALTER`/…) via `run_query`.

  The policy is re-read from `profiles.json` on every write attempt, so
  changing a connection's level takes effect without restarting the AI client.
  Because the sidecar is a headless process that can't show a prompt, the
  per-action approval stays with the MCP client, and HuginnDB records every
  write (success or failure) to `mcp-audit.log` alongside your profiles. A
  whole-table `UPDATE`/`DELETE` with no `WHERE` is refused outright, and a new
  `--read-only` flag forces every connection read-only regardless of its saved
  policy. The old `--allow-writes` flag is deprecated and inert. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.8.3] — 2026-07-16

### Added

- **Create a MongoDB collection from the explorer (#61).** MongoDB creates a
  collection implicitly on first write, so there was no way to materialize an
  empty collection from the UI — you had to insert a document first. A "New
  collection" entry now sits in the MongoDB database context menu (and a "+"
  button in the single-database toolbar, mirroring the Postgres/MySQL "New
  database" affordance), issuing an explicit `create` command via a new
  `create_collection` backend command so the collection appears in the tree
  before any document exists, matching MongoDB Compass. The name is validated
  (non-empty, no reserved `system.` prefix); non-Mongo drivers are rejected
  (they create tables through the structure editor).
- **Choose which databases a connection shows, DataGrip-style (#64).** A
  multi-database connection listed _every_ database on the server and warmed
  all of them in the background — noisy and slow on servers with dozens of
  databases. A new checklist (the list-checks button in the multi-DB explorer
  header) lets you pick the subset you actually work with; the explorer then
  renders only those and, crucially, scopes the background prefetch to them so
  connecting to a big server no longer fans out across everything. The choice
  persists per connection (`visible_databases` on the profile; `null` = show
  all, so newly-created databases keep appearing automatically). Applies to
  Postgres/MySQL and MongoDB clusters alike.
- **Import and export MongoDB collections as JSON (#65).** The whole-database
  `.sql` export never supported MongoDB. Each collection now has "Export
  collection (JSON)…" / "Import JSON…" in its context menu, using **canonical
  MongoDB Extended JSON** so `ObjectId`/`Date`/`Decimal128`/… round-trip with
  their types intact (unlike the display form the grid shows). Export streams
  straight from the cursor to the file; import accepts a JSON array, a single
  object, or newline-delimited JSON (mongoexport's default) and `insert_many`s
  the batch after a destructive-action confirmation.

### Changed

- **The OS window title now reflects the active connection and table (#57,
  #59).** Every window was titled a static "HuginnDB", making multiple windows
  impossible to tell apart from the taskbar / Alt-Tab. The title now shows
  `<profile> · <database>.<table> — HuginnDB` for the active table tab (falling
  back to `<profile> · <database>` for other tabs, and plain "HuginnDB" when
  nothing is connected), and table tabs themselves are labelled `database.table`
  instead of just the table name, so the database and table are always shown
  together. The redundant `schema › table` breadcrumb that used to sit next to
  the data-grid filter is gone — the tab title already carries that identity.
  Secondary windows are covered by the capability config (`win-*`), which also
  gives them the window permissions they need in general.
- **Connecting to a many-database server is now instant — the explorer no
  longer eagerly caches every database's tables on connect.** The multi-DB
  explorer used to warm the table list of _every_ database in the background
  right after connecting, so a connection with 19+ databases sat visibly
  "Caching schema… n/m" for a moment before settling. That eager warm was only
  ever a search optimization, and it is now redundant with the visible-databases
  selector (#64) and the active-database scope: databases load lazily when
  expanded, and the cross-database search still fans out on demand the first
  time you search. Net effect: connect is immediate regardless of how many
  databases the server has; the only trade is that the first cross-database
  search after connecting is served cold.

## [1.8.2] — 2026-07-15

### Added

- **The self-updater now catches up on releases published while the app
  stays open, instead of only checking on launch.** `checkOnLaunch` used to
  be the only trigger — an instance nobody ever closes (a shared machine, a
  workstation that's never rebooted) could sit on the previous version
  indefinitely no matter how many releases were published, since publishing
  was never the missing piece — the app just never asked again. A new
  `startPeriodicChecks` (`src/stores/update.ts`) re-runs the same check every
  4 hours for the lifetime of the running app, so a long-lived instance
  eventually notices on its own. Paired with that: the installer download
  now starts silently in the background the moment an update is detected
  (`startBackgroundDownload`), so by the time anyone actually notices the
  banner, installing is instant instead of waiting on a fresh download. The
  one thing this deliberately does **not** automate is `install()` itself —
  the step that overwrites files, force-kills the `huginndb-mcp` sidecar
  (gotcha #23), and can prompt Windows for elevation — which only ever runs
  off an explicit "Install" / "Restart now" click, never unattended. A new
  `readyToRestart` status distinguishes "downloaded, one click from done"
  from "still fetching" in both the top banner and Settings → About.
  Because installing force-kills the MCP sidecar, `installAndRelaunch` also
  checks whether it's currently running (a new `is_mcp_sidecar_running`
  Tauri command — a `tasklist`/`pgrep` shell-out, no new dependency) and, if
  so, confirms with the user first instead of silently yanking a connection
  an AI client might be mid-use of.
- **Documented Cursor and Antigravity as MCP clients, and improved the
  Settings → MCP connections list.** `huginndb-mcp` is a plain stdio MCP
  server with no client-specific code, so it already worked with any
  spec-compliant client — Cursor and Google's Antigravity IDE included — the
  gap was that `docs/MCP.md` only spelled out Claude Code, Claude Desktop,
  and Codex, leaving users of other agentic IDEs to guess at config file
  locations and JSON shapes. Added dedicated sections for both: Cursor's
  `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global), and
  Antigravity's UI-driven "Manage MCP Servers → View raw config" flow — both
  documented as using the exact same `mcpServers`/`command`/`args` shape the
  app's Settings → MCP panel already generates, so the existing JSON snippet
  pastes in as-is. Separately, the connections list in Settings → MCP now has
  a name filter and a "select all / deselect all" button (scoped to the
  currently filtered rows) plus a live `n of m selected` count — the flat
  checkbox list didn't scale past a handful of saved connections.
- **`docs/MCP.md` now has a maintained Spanish translation
  (`docs/MCP.es.md`).** The in-app Documentation viewer (Help → Documentation)
  bundled the MCP guide in English only, regardless of the user's chosen UI
  language — inconsistent with the rest of the app, which already ships full
  Spanish strings and a Spanish `CHANGELOG.es.md`. `src/lib/docs.ts` now keeps
  a per-language `bodies` map per doc entry (English always present) and
  `getDocBody` falls back to English when a translation is missing, mirroring
  `getReleases` in `lib/changelog.ts` — the same "English authoritative,
  Spanish may lag" contract used for the changelog.

## [1.8.1] — 2026-07-15

### Fixed

- **Updating on Windows while an MCP client had the `huginndb-mcp` sidecar
  running could fail with a spurious permissions error.** The NSIS installer
  stays on Tauri's default `currentUser` install mode (writes under
  `%LOCALAPPDATA%`, no elevation needed), and correctly closes a running
  `huginndb.exe` before overwriting it — but it had no idea `huginndb-mcp.exe`
  exists, since that process is spawned independently by whatever external
  MCP client has it configured (Claude Desktop, Claude Code, ...), never by
  HuginnDB itself. If a client still held it open during an in-app update,
  Windows locked the file and the overwrite failed with
  `ERROR_SHARING_VIOLATION`, surfaced to the user as a generic access-denied
  error even though no admin permissions were actually missing. A new
  `NSIS_HOOK_PREINSTALL` installer hook (`src-tauri/windows/hooks.nsi`) now
  force-closes the sidecar before any files are copied; the MCP client just
  respawns it the next time it needs the connector.
- **`huginndb-mcp` rejected SQLite and password-less MongoDB connections with
  "no stored password for keychain account ...::".** The desktop app's
  `resolve_password` helper already knows SQLite never stores a password
  (there's nothing to authenticate — it's a local file) and that MongoDB's
  is optional (it may be embedded in the connection URI, or the server may
  allow unauthenticated access), falling back to an empty string in both
  cases. The MCP server's `ensure_connected` never reused that helper — it
  called `keychain::require_password` directly, so any SQLite or bare-URI
  MongoDB connection exposed to an MCP client failed every tool call with a
  spurious "missing credential" error, even though nothing was actually
  missing. It now calls the same `resolve_password` the desktop app uses.

## [1.8.0] — 2026-07-14

### Fixed

- **MongoDB Security panel works on multi-database connections.** The 1.7.0 fix
  for #52 taught `list_collections` to return an empty list at the cluster
  level instead of erroring, but `list_users`/`list_privileges` were never
  updated the same way — opening the Security tab on a MongoDB connection with
  no preselected database still threw "no database selected". Both now run
  cluster-wide via the `usersInfo` command with `forAllDBs: true` against the
  `admin` database when no database is selected (the same cluster-level
  pattern the connection health-check ping already used), falling back to the
  existing per-database behavior otherwise.
- **MCP `run_query` no longer rejects every MongoDB query.** The read-only
  guard reused the plain-SQL keyword classifier (`select`/`with`/`show`/
  `explain`/`pragma`), which a mongosh statement like `db.coll.find({...})`
  never matches — so any MongoDB read submitted through `huginndb-mcp`'s
  `run_query` tool was rejected by default, with the only escape hatch being
  the server-wide `--allow-writes` flag (which also unlocks real SQL writes on
  every other exposed connection). The desktop query editor never had this
  problem because it classifies Mongo statements with `MongoOp::is_read()`
  before the generic gate runs; `run_query` now does the same.
- **MCP tools can target a database on a multi-database MongoDB connection.**
  `list_tables`, `describe_table`, `list_indexes`, and `browse_table` accepted
  a `schema` parameter that was silently ignored for MongoDB — every call on a
  database-less connection failed with "no database selected", with no way to
  say which database to use, and `run_query` had no way to target one for a
  bare `db.coll.find()` either. The desktop app solves the equivalent problem
  by opening a synthetic per-database pool when a user expands a database in
  the schema explorer; that logic needed no Tauri `AppHandle`/`Window` to
  begin with, so it's now shared with the MCP server, which resolves the same
  per-database pool whenever `schema` (or `run_query`'s new `database`
  parameter) names a database on a connection with none bound.
- **`browse_table`'s `limit`/`offset` accept a numeric string.** Some MCP
  clients serialize integer arguments as JSON strings despite the advertised
  schema; both fields now parse either a JSON number or a numeric string
  instead of rejecting the call outright.

### Added

- **Real per-column BSON types in MongoDB query/browse results.** `run_query`,
  `browse_table`, and the data grid used to label every column with a generic
  `"bson"` type, even though each field has a concrete BSON type. Columns now
  report the actual type inferred from the returned documents/values (`int`,
  `string`, `date`, `objectId`, …), falling back to `"mixed"` when a field's
  non-null values disagree in type across the result set — an honest answer
  rather than silently picking one. This also gives AI tools using the MCP
  connector a real type signal instead of none.
- **Collection size in the MongoDB explorer.** Collections previously always
  showed an unknown size. A single `$collStats` aggregation run at the
  database level now returns storage stats for every collection in one round
  trip (rather than one `collStats` call per collection), so the explorer can
  show an on-disk size the same way the SQL drivers do.

## [1.7.1] — 2026-07-14

### Added

- **`huginndb-mcp` now ships bundled with the installer, and Settings gained
  an MCP panel.** Previously the connector was reachable only by cloning the
  repo and building it yourself — no packaged install ever included the
  binary. It's now a Tauri sidecar (`bundle.externalBin`), installed
  side-by-side with the main executable, and the release workflow builds and
  stages it automatically. **Settings → MCP** resolves that path, lets you
  pick which saved connections to expose, and generates a ready-to-paste
  `claude mcp add`/JSON snippet — no more hunting through install
  directories or `profiles.json` for connection ids by hand. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.7.0] — 2026-07-14

### Added

- **MCP connector (`huginndb-mcp`).** A headless, read-only [Model Context
  Protocol](https://modelcontextprotocol.io) server that exposes the databases
  HuginnDB already knows about — profiles from `profiles.json`, passwords from
  the OS keychain — to AI coding tools (Claude Code, Claude Desktop, Cursor, …)
  over stdio, so an assistant can inspect real schema and data instead of
  guessing. It is a separate process from the desktop app, opens pools lazily,
  and is **opt-in per profile** (`--connections <id>`): nothing is reachable
  until you name it. Read-only by default (`run_query` rejects non-read-only
  SQL; no write tools), with a `--max-rows` cap (default 1000). Ten tools:
  `list_connections`, `list_databases`, `list_tables`, `describe_table`,
  `list_indexes`, `run_query`, `browse_table`, `server_version`, `list_users`,
  `list_privileges`. Built behind an optional `mcp` cargo feature
  (`cargo build --features mcp --bin huginndb-mcp`), so a normal
  `pnpm tauri:build` is unaffected. See [`docs/MCP.md`](docs/MCP.md).

### Fixed

- **Multi-database connections now show a name in the title bar (#51).** The
  centred breadcrumb rendered the connection's catalog directly, so a
  multi-database connection (no single preselected database) left the middle
  segment blank. It now falls back to the connection name when there is no
  single database.
- **The docked side editor no longer keeps a value from another table (#49).**
  Opening a cell in the side editor and then switching to a different tab left
  the old value on screen even though you were looking at an unrelated table.
  The panel is now scoped to the tab that opened the cell: it clears when you
  switch away (unless the buffer has unsaved edits, which are preserved so a
  tab switch never drops your work).
- **The column-resize guideline lands on the real column edge (#46).** The live
  guideline was positioned from TanStack's nominal column widths, but the grid
  uses a `table-fixed`/full-width layout that stretches columns past those
  widths when they don't fill the viewport, so the guideline drifted left of
  the actual edge (the error grew per column). It now measures the resizing
  header's rendered position.
- **MongoDB connections open without a preselected database (#52).** Opening a
  MongoDB connection in multi-database mode failed with a driver error because
  listing collections required a selected database, which blanked the whole
  tree. Listing collections at the cluster level now returns empty (as the SQL
  drivers already do), so the database list renders and you can expand into a
  specific database as before.
- **New windows are independent from the main window (#50).** "New window"
  opened a window that adopted the main window's live connection — it appeared
  connected without the user opening anything, contradicting the per-window
  independence introduced in 1.4.0. The set of open connections is now
  per-window: a window shows a connection as active only when it opens the pool
  itself. Shared configuration (saved profiles and preferences) still syncs
  across windows, and a connection closed in one window is still cleaned up in
  the others that had it open.

### Changed

- **Windows installer switched from MSI (WiX v3) to NSIS.** The release build
  started failing to bundle the `.msi` on GitHub's Windows runners — WiX v3
  has been unmaintained/archived since February 2025, and its `light.exe`
  reliably failed to even launch on the current runner fleet regardless of OS
  image (Windows Server 2022 or 2025), with no error detail beyond a bare
  process-launch failure. Tauri officially supports MSI → NSIS as an update
  path (the reverse is not supported) and the bundled `tauri-cli` here
  (2.11.1) already includes NSIS's detection of a prior MSI install. Existing
  installs auto-update to a `-setup.exe` instead of a `.msi`; the installed
  app itself is unaffected.
- **`huginndb-mcp` moved to its own workspace crate (`src-tauri/mcp-server/`).**
  The NSIS switch above then hit a second, unrelated bundler issue: with more
  than one `[[bin]]` in a package, `tauri-bundler` tries to size/bundle every
  declared binary regardless of feature gating, so it went looking for a
  `huginndb-mcp` build artifact that a normal `pnpm tauri:build` never
  produces. Moving the (already-thin) binary shim to a sibling crate keeps it
  entirely out of the app's own `cargo metadata`. Build it with
  `cargo build -p huginndb-mcp --release` from `src-tauri/` — see
  [`docs/MCP.md`](docs/MCP.md).

## [1.6.1] — 2026-07-10

### Added

- **Searchable, grouped, multi-select connections manager (#39, #43, #40).**
  The manager's left rail was a flat single-select list that got unwieldy past
  a handful of connections. It now:
  - has a **search box** filtering by name, host, database, group, or URI;
  - renders connections as a **folder tree** (grouped by the `group` field)
    with collapsible group headers — an active search force-expands so matches
    are always visible;
  - supports **multi-selection** (Ctrl/Cmd-click to toggle, Shift-click for a
    range, plus per-row checkboxes on hover) with a **bulk delete** that always
    asks for confirmation, regardless of the "confirm destructive actions"
    preference.
- **Duplicate connection (#38).** The connections manager gained a _Duplicate_
  action that clones the selected profile into a fresh draft with a uniquified
  name ("… (copy)"), ready to tweak and save. The password is intentionally not
  carried over — credentials are keyed by profile id in the OS keychain and the
  clone gets a new id — so a banner reminds you to re-enter it before
  connecting.
- **Configurable connection-group expand mode (#40).** A new General preference
  (`Connection groups`) controls how folder groups start out in the File menu
  and the connections manager — _always expanded_, _always collapsed_, or
  _remember per group_ (the previous behaviour). The File menu's groups are now
  collapsible too, matching the status-bar switcher.

- **Brand logos in the driver dropdown.** The connection editor's driver
  selector now shows each database's official logo next to its name (both in
  the trigger and the options), reusing the bundled `DriverBadge` marks already
  used elsewhere, instead of a bare list of names.
- **Live guideline while resizing data-grid columns (#42).** Dragging a column
  edge now shows a full-height vertical guideline that tracks the pointer, so
  you can see the target width before releasing instead of eyeballing it
  against the neighbouring column. The width still commits on release (the
  existing deferred, per-table-persisted behaviour).

### Fixed

- **The docked side editor now closes when its source tab closes.** The
  JetBrains-style side editor lives outside any tab's subtree, so opening a
  cell in it and then closing that table's tab left it lingering with a stale
  value, waiting for a manual discard. The cell now records its owning tab and
  the panel closes itself when that tab (or its connection) goes away.
- **Cell editor undo no longer reaches into the previously-edited cell.** The
  docked side editor (and the modal) reused a single Monaco model across cells,
  so after editing one row, selecting the same column on another row and
  pressing Ctrl+Z restored the _previous_ row's value. Monaco is now remounted
  with a fresh, empty undo stack on each cell load, so undo stays scoped to the
  current editing session; typing within a cell still undoes normally.
- **Boolean BIT cell picker no longer collapses on open (#44).** Editing an
  existing row's BIT column (with BIT shown as boolean) opened the native
  `<select>` but it snapped shut the instant you clicked an option: the cell's
  `onClick` refocused the scroll container, stealing focus from the dropdown.
  The cell now yields clicks to its own inline editor while one is active.
- **Opening a table no longer runs COUNT + SELECT twice (#41).** Two things
  doubled the initial fetch: the callback depended on `searchColumns` (derived
  from the async-loaded column list, so it changed identity and re-ran the
  effect once columns arrived), and React StrictMode double-invokes effects in
  dev. `searchColumns` is now read through a ref, and the fetch dedupes on the
  wire — a byte-identical request already in flight is skipped — so a table
  open issues exactly one COUNT + SELECT in both dev and production.

## [1.6.0] — 2026-07-08

### Added

- **Legible show/hide toggle on every password field.** WebView2 draws a
  native password-reveal eye that can't be themed and renders near-black —
  effectively invisible on dark surfaces. It's now hidden app-wide and
  replaced by a themed `PasswordInput` toggle (muted → foreground on hover,
  bilingual label). Applied to all secret fields: connection password, SSH
  password / passphrase, the export & import passphrases, the connect-time
  password prompt, and the GitHub token in the feedback dialog.

- **Tab management overhaul.** With many tabs open it was hard to tell what
  you had open or jump to a specific table. Four additions address that:
  - **Open-tabs quick switcher (Ctrl/Cmd+P).** A keyboard-first overlay
    listing _currently open_ tabs across every connection, grouped pinned-first
    then by `connection · database`. Search by name, navigate with the arrows,
    Enter jumps (and points the workspace at that tab's connection), and each
    row pins/unpins or closes inline (Delete closes the highlighted one).
    Distinct from the command palette (Ctrl+K), which opens _new_ things.
  - **Open-table markers in the schema tree.** Every table that's open in a
    tab now shows a soft brand dot in the tree — not just the active one — so
    you can see at a glance what you already have open while browsing.
  - **Tab-strip switcher button** with a live open-tab count, doubling as the
    overflow affordance when tabs don't all fit.
  - **The active tab is always scrolled into view.** Opening a table when the
    strip was already full left the new (active) tab clipped behind the
    overflow ∨ / switcher / "+" controls — dockview scrolls the active tab in,
    but does so before our custom tab content has laid out, so the new tab was
    left hidden. The active tab now scrolls itself fully into view once its
    content is painted.
  - **Pinning + richer bulk-close.** Tabs can be pinned (⋮ / right-click, or
    from the switcher) so they survive "close others / all / to the right";
    pinned tabs carry a pin marker and group first in the switcher. The tab
    menus gained "Close tabs to the right" and "Close others in this
    connection". Pins persist per connection across restarts.
- **"What's new" presentation after an update.** The first launch after an
  update bumps the app to a release flagged `major` now pops a curated,
  iconified highlights dialog (the punchy counterpart to the exhaustive
  changelog in Settings → About). Content is a hand-authored, bundled
  catalogue in `src/lib/releaseNotes.ts` with bilingual copy in i18n; the
  seen-marker is persisted in `localStorage` (mirroring the update store) so
  it fires exactly once per major release, main-window only. Reachable any
  time from Help → "What's new". When cutting a `major` release, add its entry
  (matching the manifest version exactly) and flag it `major`.
- **Visible Run button in the query editor (UI/UX overhaul, phase 2).** The
  editor's primary action had no button at all — it was Ctrl+Enter and a
  per-statement CodeLens only, with a "Run all" that appeared conditionally. A
  brand-filled Run button now leads the toolbar with a Ctrl/⌘+Enter shortcut
  chip, runs the whole buffer (routing to the batch runner when it holds more
  than one statement), and shows a spinner while executing. Save / history are
  demoted behind a divider.
- **Schema tree redesign (UI/UX overhaul, phase 1).** The left database/table
  tree gained clear hierarchy and orientation. The currently-open table is now
  marked in the tree — a soft brand wash plus a 2px inset brand rail, driven by
  the active tab — so you can always see "where you are". The table name is the
  boldest element on its row (foreground / medium weight) against the muted
  section labels and column rows, column data types are colour-coded (numeric
  amber / boolean green / others muted, reusing the grid's semantic hues), and a
  table's columns load behind a shimmer skeleton instead of an italic
  "loading…" line. Column indentation follows a consistent 12px-per-level
  ladder (schema → section → table) with a continuous depth-guide hairline that
  drops from under each open table's chevron, and table metric badges use
  tabular figures. The single-database "database created" confirmation is now a
  themed toast instead of a native `alert()`.
- **Keyboard navigation in the data grid (UI/UX overhaul, phase 1).** The grid
  was mouse-only, at odds with the app's keyboard-first identity. Cells now
  carry a keyboard-navigable "active cell" marked with an inset `brand` ring:
  arrow keys move it, Home / End jump to the row's first / last column, Enter
  opens the cell editor (inline / FK combobox / modal, same routing as
  double-click) and Escape clears it. Clicking a cell seeds the active cell so
  the keyboard picks up from there, and the active cell scrolls into view as it
  moves (instantly — the indicator never animates, since it tracks every
  keypress).
- **Visible row-selection checkboxes in the data grid (UI/UX overhaul, phase 1).**
  Multi-row selection already worked via Ctrl/Cmd- and Shift-click, but there
  was no visible affordance — the `#` gutter only ever showed the row number, so
  the feature was undiscoverable. The gutter now renders a tri-state select-all
  checkbox in the header (checked / indeterminate / empty over the visible rows)
  and a per-row checkbox that appears on row hover and stays while the row is
  selected. Both are backed by the existing PK-keyed selection set (survives
  sort / filter / refetch) and tinted with the `brand` token; row numbers now
  use `tabular-nums`.
- **Export and import whole databases (#34), marked Beta.** No way to get a database out
  of HuginnDB (or back in) short of scripting it by hand. "Export database…"
  (multi-DB explorer context menu, or a toolbar button on a single-DB
  connection) dumps schema + data to one portable `.sql` file for
  Postgres, MySQL, or SQLite. Postgres/MySQL write in three phases — bare
  `CREATE TABLE`, then all data, then `ALTER TABLE ADD CONSTRAINT` (FK) +
  `CREATE INDEX` — so a whole-database dump never needs a table-dependency
  topological sort and never needs elevated privileges (e.g. Postgres's
  superuser-only `session_replication_role`). SQLite instead dumps its
  catalog verbatim from `sqlite_master` (higher fidelity than reconstructing
  DDL — it keeps `CHECK` constraints etc.) bracketed by
  `PRAGMA foreign_keys=OFF/ON`. "Import .sql…" picks a file and runs it
  through the _existing_ query batch runner (the same `splitSql` +
  `execute_batch` path the query editor already uses) instead of a second
  execution path, gated behind the destructive-action confirmation. Labelled
  Beta in the UI — verified by type-checking and `cargo check` only so far,
  not yet exercised end-to-end against a live server on all three drivers.
- **Free-form tab colour, and a selectable accent style (#35).** The tab
  colour picker offered only six fixed swatches; a native colour input now
  sits alongside them for any hex value. Separately, the active-tab / custom
  colour accent was hard-coded to a 2px top cap — a new
  Settings → Grid → "Tab accent style" preference (`cap` / `rail` / `boxed`)
  switches it to a left rail or a raised-surface look instead, and a custom
  tab colour now follows whichever edge the chosen style uses instead of
  always drawing on top.

### Changed

- **Themed tooltips (UI/UX overhaul, phase 3).** Added a `SimpleTooltip`
  convenience wrapper over the themed Tooltip primitive and migrated the app
  chrome off native `title=""` so its tooltips match the app's theme instead of
  the OS default: the header buttons (theme toggle, preferences), every
  status-bar affordance (command palette, query-history, density and theme
  toggles, the connections switcher) and the workspace tabs (label, actions ⋮,
  close, new-query +). Menu/context triggers are wrapped at the trigger so the
  tooltip fires on hover while the menu still opens on click. The one case left
  on native `title=""` — deliberately — is a tooltip that lives _inside_ open
  menu content (the connection rows' reconnect/disconnect, the tab colour
  swatches): a Radix tooltip there fights the menu's own hover/portal handling,
  and a native OS tooltip doesn't.
- **Clearer connection status (UI/UX overhaul, phase 3).** A lost connection —
  arguably the most important operational signal — was a 6px red dot plus a
  cryptic red icon. Lost rows in the status-bar connection switcher now get a
  destructive row wash and an explicit labelled "Reconnect" button; the
  live/lost indicator dots are a touch larger, the row action buttons have a
  real hit area, and a failed connect surfaces a toast instead of a native
  `alert()`. Status-bar stats (row count, elapsed time, selection) promote their
  numbers to the foreground with tabular figures.
- **Accessible tab actions + active-tab weight (UI/UX overhaul, phase 3).** The
  workspace tabs' close (×) and actions (⋮) buttons were revealed on hover only,
  leaving them unreachable by keyboard; they now also appear on keyboard focus
  (focus-within / focus-visible). The active tab's label gains medium weight to
  match the brand top-cap + raised surface it already carries.
- **Distinctive dialog shell (UI/UX overhaul, phase 3).** Every dialog rode a
  flat `shadow-lg` with a fade-only entry and a bare low-opacity close glyph.
  `DialogContent` now scales in from centre (zoom, the correct motion for a
  centred modal), rides the shared elevation scale (`shadow-elevation-4`), and
  its close button is a properly padded control with a hover background instead
  of a hit-area-less 70%-opacity X.
- **Shared segmented control + console/structure cleanup (UI/UX overhaul,
  phase 2).** A new `Segmented` primitive (keyboard-navigable radiogroup styled
  as one pill strip with a raised active segment) replaces the hand-rolled
  variants: the feedback dialog's bug/feature toggle (two full buttons) and the
  structure editor's section tabs (plain buttons with no active-tab language).
  The console's log filter now uses the shared `Input` (small size) instead of
  a hand-rolled search box, and its kind checkboxes are tinted with `accent-brand`.
- **CellEditor flagship framing (UI/UX overhaul, phase 2).** The Monaco cell
  editor — the app's "star feature" — looked like a stock dialog. It now has a
  titled header rail: the column name, a `brand`-tinted content-type badge
  (JSON/XML/SQL/TEXT), and char/byte-count pills, with the panel/fullscreen
  controls grouped to the right. Ctrl/⌘+S and Ctrl/⌘+Enter save from inside the
  editor (bound via Monaco so they aren't swallowed) with the shortcut shown in
  the footer, the JSON-validity badge is now a compact chip with the parser
  message in its tooltip instead of dumped inline, and the brittle `mr-8`
  close-button-dodge hack is replaced by reserved header padding.
- **Command palette polish (UI/UX overhaul, phase 2).** The flagship
  keyboard-first surface gained the affordances it was missing: a persistent
  footer legend (↑↓ navigate · ↵ run · esc close), a trailing ↵ on the active
  row, a `brand` left-edge accent + brand-tinted icon on the active row, group
  counts on the section headers, and an iconified empty state. The highlighted
  row now scrolls into view during arrow-key navigation (it could previously
  scroll off-screen), and a failed connect surfaces a toast instead of a native
  `alert()`.
- **Unified table-browser chrome (UI/UX overhaul, phase 1).** A table tab used
  to stack two near-identical toolbars. The top bar's breadcrumb (schema ›
  table) and refresh now fold into the data grid's own toolbar so there's a
  single bar, and paging + row-zoom move to a footer status strip with tabular
  figures. The first load of a table shows a shimmer skeleton (with the
  breadcrumb) instead of a bare "loading…" line, and a refetch dims the stale
  rows behind a spinner rather than looking frozen. The delete-row confirmation
  button now uses the destructive (red) style, matching the drop-table dialog.
- **Data-grid readability polish (UI/UX overhaul, phase 1).** Column headers now
  show a persistent sort glyph that brightens on hover (it was a near-invisible
  30%-opacity icon), and the whole header cell gets a hover background so
  sortability is discoverable; the active-sort indicator is right-aligned and
  tinted with `brand`. Numeric readouts — the row count, pagination range and
  query elapsed time — use tabular figures so they stop shifting width as they
  change, the row/total counts are emphasised in the foreground, and the
  elapsed time turns amber then red only when a query is slow.
- **Tokenised data-semantic accents (`--pk` / `--fk` / `--numeric`).** The
  primary-key / foreign-key key icons and numeric cell values were hard-coded
  as `amber-400` / `sky-400` in the grid and schema tree, ignoring the active
  theme. They're now theme tokens (curated per built-in theme; darker on light
  themes so numerics stay legible on white) applied in DataGrid and
  SchemaExplorer. Kept out of the Appearance colour editor as niche system
  accents.
- **Design-system foundation (UI/UX overhaul, phase 0).** First pass of a
  larger interface redesign toward a modern, dense dev-tool look. No new
  features — this is groundwork the rest of the overhaul builds on:
  - Two new semantic theme tokens, `--success` and `--warning`, distinct from
    `brand` (the app's one "live / do this" accent) and `destructive` (errors).
    Every built-in theme sets its own curated values and both are editable in
    Settings → Appearance like any other colour. This replaces the hard-coded
    `emerald-*` / `amber-*` / `blue-500` / `red-500` literals that were
    scattered across ~12 components and ignored the active theme entirely — so
    custom themes now recolour connection-status, valid/invalid, warning and
    error affordances. `applyTheme` also clears any token a (pre-existing)
    custom theme doesn't define, letting the stylesheet default apply instead
    of leaving a stale inline value from the previously active theme.
  - Unified the "this connection is live" indicator on the `brand` token; it
    previously rendered emerald in the File menu but brand in the status-bar
    switcher for the exact same state.
  - Added an elevation scale (`shadow-elevation-1…4`, keyed off `--foreground`
    so it reads in both light and dark themes) and a tokenised micro-type scale
    (`text-2xs` / `text-3xs`, with a 10px legibility floor) to replace ad-hoc
    `text-[9px/10px/11px]` values.
  - Stronger, consistent keyboard focus ring (`ring-2` + offset) on buttons,
    inputs and selects, replacing the near-invisible 1px flush ring.
  - Form field labels now default to `text-foreground` instead of muted grey,
    giving every dialog real label/value hierarchy.
  - `Input` gained density variants (`inputSize` default/sm/xs) and a new shared
    `Textarea` primitive replaces the hand-rolled multiline fields in the
    feedback and save-query dialogs.
  - Defined a real UI sans-serif font stack (Inter first, falling back to the
    platform UI font) instead of relying on the bare system default.

### Fixed

- **Long table names no longer force horizontal scroll in the schema tree
  (#33).** The table-name label had `truncate` but, as a flex child with no
  `min-w-0`, never actually shrank below its content width (flex items
  default to `min-width: auto`) — so a long name pushed the row-count/size
  badge off and the tree scrolled horizontally instead of ellipsizing.
- **The tab's right-click menu now matches its ⋮ menu (#36).** The two were
  hand-maintained separately and had drifted: right-click was missing
  Split right/down, Float panel, and the colour swatches that the ⋮ menu
  already had. Both now show the same actions in the same order.

## [1.5.1] — 2026-07-07

### Added

- **Drop database from the multi-DB explorer (#19).** The database node's
  context menu gained a destructive "Drop database…" action (Postgres/MySQL
  only), so a database you created can also be removed — previously the node
  only offered "New query here" / "Security" and a created database was stuck.
  A new `validate_ident`-guarded `drop_database` backend command closes the
  synthetic per-database pool (awaiting `Pool::close`) before issuing `DROP
DATABASE`, so Postgres doesn't reject it for having live sessions; on success
  the UI tears down that database's tabs + schema slice and refreshes the tree.
- **Connection groups shown as folders in the File menu (#20).** The File menu
  listed every connection flat, so a profile's `group` had no visible effect
  there. Connections are now bucketed by group: ungrouped first, then one
  labelled folder per group (sorted) with its connections indented beneath.
- **Themed combobox for the Group field (#21).** The connection editor's Group
  field used a native `<datalist>` whose suggestion popup was drawn by the
  OS/webview and ignored the app theme. It's now a themed, still-creatable
  combobox (typing a new name still creates a new group) that substring-filters
  existing group names in an in-theme popover.
- **Tab colour coding (#24).** Open tabs can be colour-coded from the tab's ⋮
  menu (six preset swatches + clear); the colour shows as a 2px cap on the
  tab's top edge and persists per connection.
- **Refresh button in the structure editor (#25).** The table-structure tab
  gained a refresh button that re-reads the table's current definition from the
  server, so changes made elsewhere while the tab is open can be pulled in.
- **Scroll-to-top / scroll-to-bottom in the console (#29).** Two toolbar
  buttons jump the console log to its first or last entry.
- **Active connection marked in the status dropdown (#31).** The connection the
  workspace is focused on now gets a brand wash + "active" tag in the status-bar
  dropdown, distinct from the other merely-connected rows.

### Fixed

- **Connection errors no longer clip at the dialog edge.** A failed Test /
  Connect rendered its (often long) backend message on a single `truncate`d
  line in the connection dialog footer, so anything past the dialog width was
  cut off with an ellipsis and unreadable — most database driver errors are far
  wider than the footer. Error and save-error states now get a bounded,
  wrapping, vertically-scrollable box (destructive-tinted, with an alert icon)
  and a one-click copy button for the full message; the short states (testing /
  success / saved) stay on their single line.
- **Same table on two connections/databases no longer renders identical tabs
  (#22).** Tab labels only carried a connection prefix when more than one
  distinct connection had tabs open, and the prefix omitted the database, so
  the same table opened on two connections (or two same-named databases) showed
  as an indistinguishable bare name. Labels now include `connection · database`
  context and escalate to it whenever another open tab shares the bare title.
- **A CLI second-launch no longer spawns a third window (#23).** With "always
  open in a new window" set, launching again from the CLI while an instance was
  running produced three windows. The second-launch routing ran in every
  window, so the window spawned to satisfy the "new window" route re-drained the
  shared pending-intent buffer and routed it a second time. Routing is now
  gated to the main window only.
- **Empty tables show their columns and the insert affordance (#27).** A table
  with no rows rendered no column headers and no way to add the first row,
  because the result decoders derive columns from the first row. `fetch_table_data`
  now falls back to the catalog definition when a page comes back empty.
- **DDL apply failures are surfaced (#26).** A structure change the database
  rejects — e.g. a primary key exceeding MySQL's max key length — only showed a
  message in the small DDL-preview pane and read as a silent no-op. It now also
  raises a toast.
- **The port field can be cleared (#28).** Emptying a numeric port field snapped
  back to a stuck `0` that couldn't be backspaced away. Falsy `0` now renders as
  an empty field, restoring normal clear/retype (all four port inputs).
- **No text highlighting on Shift+Click row selection (#30).** Range-selecting
  rows also dragged a native text selection across their contents; the grid is
  now `select-none`.
- **Connection dropdown consistency (#31).** The File-menu dropdown now shows
  connection groups (see the grouping change above) and the status-bar dropdown
  marks the active connection, resolving both halves of the report.

## [1.5.0] — 2026-07-04

### Added

- **Create database.** Both the multi-DB explorer toolbar and the
  single-database root header gained a "+" button (Postgres/MySQL only —
  server-level DDL, hidden for SQLite/MongoDB) that opens a name dialog and
  issues `CREATE DATABASE` via a new `create_database` backend command,
  validated through the same `validate_ident` allowlist the structure
  editor uses. The multi-DB toolbar refreshes its database list on success;
  a single-DB connection has no such list to show the change, so it
  confirms with a message instead (a profile scoped to one database is at
  least as common as multi-DB browsing — there's no reason it should be the
  one mode that can't create a sibling database on the same server).
- **Resizable data-grid columns.** `DataGrid.tsx` now wires up TanStack
  Table's column-resizing API (drag handles on column borders,
  `columnResizeMode: "onEnd"` so a drag doesn't spam re-renders). Widths are
  persisted per browsed table (`prefs.json`'s new `grid.columnWidths`,
  keyed by `"<schema>.<table>"` then column name) — ad-hoc query result
  grids resize in-session only, matching how they don't have a stable table
  identity to key against.

- **Connection grouping.** `ConnectionProfile` gained a free-text `group`
  field (single group per connection, no separate group registry — grouped
  by simple string equality), editable from a new "Group" field in the
  connection dialog (with a datalist of existing group names as a
  duplicate-avoidance nudge). The status-bar connections dropdown
  (`StatusConnections.tsx`) — the app's actual live connection
  switcher — now buckets both the Active and Available sections into
  collapsible per-group headers, with ungrouped connections staying flat at
  the top exactly as before. Collapse state persists per group name in
  `prefs.json` (`ui.collapsedConnectionGroups`). New `bucketByGroup` helper
  in `src/lib/utils.ts`.

### Fixed

- **Connecting the same profile from a second window tore down the first
  window's live pool.** `ActiveConnections::insert` unconditionally replaces
  whatever pool is already registered for an id — correct for reconnecting
  a dead pool, wrong for a second window's `connect` call racing an
  already-active profile, which silently dropped the first window's pool
  (and any SSH tunnel) out from under it. `connect` now checks
  `ActiveConnections::contains` first and no-ops (reusing the existing
  pool) instead of falling through to the replace path.
- **No window learned about another window's connections, profile edits, or
  preference changes.** Every Tauri window shares one backend `AppState`,
  but each window's frontend held a private snapshot of `active`/`profiles`/
  `prefs` taken once at boot with no bridge back out — worse than staleness
  for preferences specifically, since every save sends the _entire_ blob
  (not a diff): two windows changing different settings would silently lose
  whichever saved first the moment the other's debounced write landed.
  `connect`/`disconnect`/`save_profile`/`delete_profile`/`import_profiles`/
  `update_preferences` now broadcast `connection-opened`/`-closed`/
  `profiles-changed`/`prefs-changed` events; new frontend bridges
  (`connection-sync-bridge.ts`, `prefs-sync-bridge.ts`) apply them to every
  window's stores — `markConnected`/`markDisconnected` in
  `stores/connections.ts` (factored out of `connect()`/`disconnect()` so
  the sync path and the local path share the exact same cleanup, including
  the multi-DB synthetic-child tab/schema sweep) and `applyExternal` in
  `stores/preferences.ts` (adopts the broadcasted snapshot without
  re-triggering a save, so it can't loop or re-race).
- **MySQL `insert_row`/`update_cell` could bind a `BIT` column as plain text
  when the frontend's schema-cache metadata hadn't loaded yet.** Both
  commands decide whether to wrap a MySQL `BIT` column's placeholder in
  `CAST(? AS UNSIGNED)` based on a `column_type` hint the frontend sends
  alongside the value; when that hint is `None` (schema cache empty/stale
  for the target table), the value was bound as a plain string, which
  MySQL rejects with `1406 (22001): Data too long for column` for anything
  wider than one character (e.g. `"true"`). Both commands now fall back to
  a catalog lookup (`list_columns_inner`, the same helper `fetch_fk_options`
  already uses) when the hint is missing, so a `BIT` column is detected
  correctly either way. `insert_row` only pays for the extra round-trip
  when at least one value actually lacks a type hint.
- **Console/connection-lifecycle log entries leaked across windows.** Every
  Tauri window (the main window, or any secondary "New window") mounted the
  same frontend and independently subscribed to the same backend log event,
  which was broadcast process-wide (`AppHandle::emit`) rather than targeted —
  so a query run in one window showed up in every other open window's
  Console panel too, making a secondary window look like a pointless copy
  of the main one instead of an independent instance. `log_bus::emit` now
  takes the originating window's label and delivers only to it
  (`AppHandle::emit_to`); every command that produces a SQL or
  connection-lifecycle log entry (`execute_query`, `execute_batch`,
  `fetch_table_data`, `update_cell`, `delete_rows`, `insert_row`, `connect`,
  `disconnect`, `test_connection`, `open_database_view`) now takes a
  `tauri::Window` parameter (auto-injected by Tauri from the invoking
  webview — no frontend change needed) to supply it. The keepalive
  background task's own diagnostic log entry has no single originating
  window (it reports on a connection every window may be browsing), so it
  keeps broadcasting via a new `log_bus::broadcast`; the separate
  `connection-lost` event it emits for the reconnect UX was already correct
  as a broadcast and is unchanged.

## [1.4.0] — 2026-07-02

### Added

- **Server-side users/permissions ("Security" panel).** A new `Security`
  action next to the schema explorer's refresh button (and, per database, in
  the multi-DB explorer's context menu) opens a tab listing the users/roles
  the current connection can see, with lazy-loaded privileges on row expand.
  Implemented for every driver rather than a subset: **PostgreSQL**
  (`pg_roles` + `pg_auth_members` for role membership, table grants via
  `information_schema.role_table_grants`), **MySQL** (`mysql.user` +
  `mysql.role_edges` for MySQL 8 roles, privileges parsed out of
  `SHOW GRANTS FOR '<user>'@'<host>'` since MySQL has no privilege catalog
  view equivalent to Postgres'), **MongoDB** (`usersInfo` per the resolved
  database, privileges via `usersInfo` with `showPrivileges: true`), and
  **SQLite**, which has no user/permission concept at all and now renders an
  explicit "this driver has no server-side user model" empty state instead
  of silently omitting the feature. A MySQL account without `SELECT` on
  `mysql.user` degrades to reporting just itself (`CURRENT_USER()`) instead
  of failing the whole panel. New backend commands `list_users` /
  `list_privileges` in `src-tauri/src/commands/schema.rs` (dispatched to
  `src-tauri/src/db/mongo/schema.rs` for MongoDB); new `UserInfo` /
  `PrivilegeInfo` DTOs mirrored in `src/types.ts`; new frontend
  `SecurityTab.tsx` (TanStack Table) and `security` tab kind.
- **Connection keepalive + lost-connection reconnect.** HuginnDB previously
  did nothing proactive to keep a connection alive — no idle timeout, no
  heartbeat — relying entirely on `sqlx`'s default "validate on next use"
  behaviour, which doesn't help an idle pool between user actions or a
  dropped SSH tunnel. Every top-level connection now gets a background ping
  every 3 minutes; a failed ping flags the connection as lost, which turns
  its status dot red in both the connection list and the status-bar
  connections dropdown and swaps the connect/disconnect button for a
  one-click "reconnect" — no more discovering a dead connection mid-query
  with only a cryptic driver error. Reconnecting reuses the same connection
  id and keeps open tabs and schema-tree state intact rather than closing
  everything and starting over. Scoped to top-level profile connections
  only; the synthetic per-database pools used by multi-DB browsing share
  their parent's liveness and don't get a separate heartbeat. New backend
  module `src-tauri/src/keepalive.rs`; new frontend
  `stores/connectionHealth.ts` + `lib/connection-health-bridge.ts`.
- **F5 / Ctrl+R (Cmd+R on macOS) now refresh in-app instead of reloading the
  WebView like a browser tab.** With a table tab active, it re-runs that
  tab's own query (same as clicking its reload button, respecting the
  current filters/sort/page); otherwise it refreshes the schema tree
  (database + table list) for the selected connection — matching the
  explorer's own refresh button in both single-DB and multi-DB mode. New
  `src/lib/tableRefresh.ts` registry (same "populate on mount, clear on
  unmount" shape as the Monaco SQL provider registry) lets the global
  key handler in `App.tsx` reach the active table tab's reload function
  without threading a callback through the dockview panel tree.

### Changed

- **Workspaces replaced by native windows.** Workspaces were only ever a
  stand-in for real per-window instances, and the "new workspace vs current"
  dialog shown on a second `huginndb …` launch never worked correctly. The
  workspace switcher is gone; **Window → New window** opens a real, blank OS
  window instead. Secondary windows are intentionally ephemeral — nothing
  about their tabs or layout survives an app restart, only the main
  window's does. The on-disk `tab_state.json` moves to v3 (a flat
  `connections` map); on upgrade, a v2 blob keeps only the previously
  **active** workspace's tabs and discards every other workspace — there is
  no merge. The second-launch dialog still asks "this window or a new one?"
  by default, but now offers a "don't ask again" toggle that remembers the
  choice (`Preferences → cliConnectDefault`).
- **Top bar menus split from 2 to 4.** File and View had accumulated
  unrelated actions as the app grew. File now holds only connection
  management (new/manage/import/export, the connection list, disconnect
  all); a new **Window** menu takes New window and Reset window layout; a
  new **Help** menu takes Report/suggest and About (previously File-only
  and gear-icon-only, respectively). View is unchanged (panel visibility +
  schema-tree metric).

### Fixed

- **A new window created via "Window → New window" rendered blank and
  Windows flagged it as "Not Responding".** `WebviewWindowBuilder::build()`
  deadlocks on Windows when called from a synchronous Tauri command — a
  documented WebView2 issue. `open_new_window` is now an `async fn`, which
  Tauri docs call out as the fix.
- **A CLI ad-hoc connection (`--host …`) without `--password` never
  actually connected**, even when chosen via the second-launch dialog's
  "this window" option — it silently created a disconnected profile and
  only logged a hint to the Console. The connect is now always attempted
  (SQLite has no password concept at all, and some servers allow
  passwordless/trust auth); a genuine auth failure still surfaces the same
  way a saved-profile connect failure does.

## [1.3.0] — 2026-07-01

### Added

- **"I don't have a GitHub account" fallback in the issue reporter.** Both
  existing paths (API creation with a stored PAT, or the pre-filled
  `issues/new` browser page without one) still land on GitHub, which is a
  dead end for a user with no account — the browser page just shows a login
  wall. A new link in the dialog's footer builds a `mailto:` URL instead
  (same title/kind-prefixed subject and body, diagnostics block included when
  toggled on) and opens it via the `opener` plugin, handing delivery to the
  user's own default mail app — HuginnDB never touches SMTP or holds a
  mail-sending credential. Percent-encoding is hand-rolled (RFC 3986
  unreserved set) rather than reusing `url`'s `query_pairs_mut`, which is
  `application/x-www-form-urlencoded` and would turn spaces into literal `+`
  characters in the body — technically invalid in a `mailto:` query and
  rendered as-is by several mail clients. The recipient is the project's
  `contact@shion.es` address, kept separate from the mailto path's GitHub
  siblings so a stray report can't be mistaken for a security disclosure.
  Requires widening the `opener:allow-open-url` capability, previously scoped
  to `github.com` only, to also allow `mailto:*`.

- **"Go to referenced row" on foreign-key cells (IDE-style).** In the data
  browser, **Ctrl/Cmd+click** on a cell whose column is a single-column foreign
  key now jumps straight to the referenced master record — opening (or focusing)
  the parent table pre-filtered to that value, the way "go to definition" works
  in an editor. The same action is available from the cell's right-click menu
  ("Go to referenced row"), and FK-navigable cells gain a subtle hover
  underline. Reuses the FK metadata already returned by `list_columns`
  (`referenced_schema` / `referenced_table` / `referenced_column`) — no new
  backend query. The target table receives the filter through a new transient
  `initialFilters` on the tab; re-navigating into an already-open table
  re-applies it instead of silently doing nothing.
- **"New query here" on a database (multi-DB explorer).** Right-clicking a
  database node in the multi-database explorer now offers _New query here_,
  opening a query tab already scoped to that database. It runs against the same
  synthetic per-database connection the explorer uses, so the query targets the
  database you clicked without first having to expand it or switch the active
  scope.

### Fixed

- **The in-app issue reporter now actually opens the browser.** Filing a report
  (or following the "view issue" link) relied on `window.open`, which is a no-op
  inside the Tauri WebView — clicking did nothing. URL opening now goes through
  the `tauri-plugin-opener` plugin and lands in the OS default browser. The new
  capability is scoped to `github.com`, the only host the reporter ever links
  to. Adds the `tauri-plugin-opener` dependency.
- **Hand-typed `INSERT`/`UPDATE` with `BIT`/integer values no longer errors on
  MySQL.** Ad-hoc statements from the SQL editor were sent over the prepared
  (binary) protocol, which rejects or mishandles a family of statements a CLI
  client runs without complaint — the recurring `BIT` / integer-literal errors.
  The editor binds no parameters, so there is nothing to prepare: non-`SELECT`
  statements now run through the **unprepared** simple-query protocol
  (`sqlx::raw_sql`) in both the single-statement and batch paths, so what you
  type is parsed exactly as the server's own client would. `SELECT` decoding is
  unchanged.

## [1.2.0] — 2026-06-18

### Added

- **Single-window consolidation (single instance).** Launching `huginndb` again
  while a window is already open no longer spawns a second window. The running
  window is focused, and — if the new launch carries a connection
  (`--connect-profile`, `--host …`, `--uri …`) — a dialog asks whether to open
  it in a **new workspace** or the **current** one. This makes the workspace the
  real top-level container: keep, say, a MySQL "config" connection and a MongoDB
  "data" connection side by side in one window instead of two detached IDE-like
  instances. A relaunch with no connection flags simply brings the window to the
  front. Implemented with `tauri-plugin-single-instance`; the second launch's
  argv is parsed by the same code path as cold start and forwarded over a new
  `huginndb://cli-connect` event (buffered backend-side to survive a launch that
  races the window's boot).
- **In-app issue reporter.** A new _Report / suggest_ entry (File menu, and a
  "Report this error" action on failed Console entries) opens a dialog to file
  a **bug** or a **feature request** straight to the GitHub tracker. With a
  GitHub Personal Access Token configured (stored in the OS keychain, never on
  disk) the issue is created directly via the REST API and linked back; without
  one, a pre-filled `issues/new` page opens in the browser for manual
  submission. Reports can optionally bundle diagnostics (app version, OS/arch),
  and the "Report this error" path pre-fills the driver, statement, and error
  text. Adds a `reqwest` (rustls) dependency for the API path.
- **Multi-column sort in the data grid.** A plain click on a column header
  sorts by it (cycling ASC → DESC → unsorted); **Ctrl/Cmd+click** adds the
  column as an additional, lower-precedence sort level (cycling
  ASC → DESC → removed in place). Headers now show a direction arrow (↑/↓)
  instead of only highlighting, plus a small level number when more than one
  column participates, so the active ordering is readable at a glance rather
  than only inferable from the console. The `fetch_table_data` command now
  takes an ordered `order` list (replacing the single `orderBy`/`orderDesc`
  pair) and builds `ORDER BY c1 …, c2 …` across all four drivers (the MongoDB
  path uses a multi-key sort document).
- **Primary/foreign-key icons on data columns.** The data-grid column headers
  now show a key icon — amber for a primary-key column, sky-blue for a
  single-column foreign key — and the schema explorer gains the foreign-key
  key next to the existing primary-key one. Mirrors HeidiSQL's at-a-glance key
  indicators; uses metadata already returned by `list_columns`, no extra
  queries.

### Performance

- **Skip the redundant `COUNT(*)` when only sorting or paging.** The data
  browser previously re-ran `SELECT COUNT(*)` on every fetch, including pure
  sort/offset/page changes where the total can't have changed. The frontend
  now caches the total and recomputes it only when the filter/search predicate
  changes (new `with_count` flag on `fetch_table_data`), removing one
  round trip per sort/page interaction — most noticeable on large tables. The
  MongoDB browse path skips `count_documents` the same way. (Sorting on a
  non-indexed column is still a server-side full sort; that's governed by the
  table's indexes, not the client.)

### Changed

- **Simpler "Drop table" confirmation.** Dropping a table no longer requires
  typing the table name to confirm — it now shows a plain destructive
  confirmation dialog (with an irreversibility warning) and a Cancel / Drop
  choice, matching what users expect from other database managers. The action
  is still gated behind an explicit confirmation; only the type-the-name
  friction was removed.

## [1.1.1] — 2026-06-15

### Added

- **MongoDB connection form (field-driven).** The MongoDB connection dialog is
  now form-primary, like Mongo Compass: discrete fields (host, port, database,
  username, password, **auth source**) build the `mongodb://` connection string
  live, shown read-only below them. A new **Edit connection string** toggle
  reveals the raw URI for hand editing — with an amber warning that manual edits
  can introduce errors — for cases the form doesn't cover (Atlas
  `mongodb+srv://`, replica sets, extra URI options). The password is never
  embedded in the stored string: it continues through the OS keychain. Editing a
  saved profile re-populates the form when its URI is representable, and opens in
  raw-edit mode otherwise.
- **`authSource` for MongoDB.** A dedicated _Auth source_ field (e.g. `admin`)
  is appended to the connection string as `?authSource=…`, and a new CLI
  `--auth-source` flag covers the URI-less ad-hoc path
  (`--host … --auth-source admin`). Previously the only way to set it was to
  hand-write the whole URI, and the discrete-field path omitted it entirely —
  so URI-less MongoDB logins that needed a non-default auth database failed.
- **Multi-table filter in the schema explorer (HeidiSQL-style).** The table
  filter now accepts several `;`-separated patterns and matches a table when it
  contains **any** of them, so `users; orders` surfaces both at once. Works in
  both single- and multi-database explorers.

### Fixed

- **The Console detail pane can be closed without clearing the console.**
  Clicking a log entry opened its detail view with no way back to the full list
  short of emptying the console; a **close** button (and the `Esc` key) now
  dismiss the detail and return to the entry list.

## [1.1.0]

### Added

- **MongoDB driver (MVP).** HuginnDB now connects to MongoDB alongside the SQL
  engines. Connect with a connection string (`mongodb://…` or Atlas
  `mongodb+srv://…`, the primary input — it covers replica sets, `authSource`
  and URI options), browse databases → collections in the explorer, and inspect
  documents in the data grid (top-level fields become columns, `_id` first;
  nested documents/arrays render as JSON and expand in the cell preview).
  - **`mongosh`-style query editor.** Run `db.coll.find({…})`,
    `.aggregate([…])`, `.countDocuments(…)`, `.distinct(…)`, and the write
    methods (`insertOne`/`insertMany`, `updateOne`/`updateMany`, `replaceOne`,
    `deleteOne`/`deleteMany`), with chained `.sort()/.limit()/.skip()/.projection()`
    on `find`. Relaxed JSON (unquoted keys, single quotes) and the common BSON
    constructors (`ObjectId(...)`, `ISODate(...)`, `NumberLong/Int/Decimal(...)`)
    are supported.
  - **Edit by `_id`.** Inline cell edits, row inserts and deletes map to
    `updateOne`/`insertOne`/`deleteMany` keyed on `_id`. The field's inferred
    BSON type drives value coercion so a `Date`/`Long`/`Int` field is not
    silently degraded to a string.
  - **Read-only structure.** The structure view shows a collection's inferred
    fields and real indexes; collection drop is supported from the explorer.
    Index/validator editing, transactions, and profile transfer for MongoDB are
    deferred — see `docs/MONGODB_ROADMAP.md`.
  - **SSH tunnelling** is available for single-host `mongodb://` connections;
    it is disabled for `mongodb+srv://` (an SRV record resolves to several
    hosts, which the single-port tunnel can't represent).
  - **CLI:** `--driver mongodb` works with the discrete `--host`/`--port`
    flags, and a new `--uri` / `--connection-string` flag accepts a full
    `mongodb://` or `mongodb+srv://` URI (the only way to reach Atlas from the
    CLI). A connection string implies the MongoDB driver when `--driver` is
    omitted, and MongoDB is now offered in the ad-hoc driver picker.
- **Bulk-close tabs from the tab menu.** Right-clicking a workspace tab (or the
  tab's `⋮` menu) now offers **Close other tabs** and **Close all tabs** in
  addition to **Close tab**, so a workspace full of open tables/queries can be
  cleared in one action instead of closing each tab individually.

### Fixed

- **Filtering the schema explorer no longer crashes on connections without table
  stats.** `list_tables` serialized absent row-count / size statistics as JSON
  `null`; the explorer's metric badge guarded only against `undefined`, so a
  `null` reached `formatBytes` and threw _"Cannot read properties of null
  (reading 'toFixed')"_ — taking down the whole panel. This bit CLI/ad-hoc
  connections and SQLite builds without `dbstat`, and surfaced on filter because
  the filter force-expands every section (rendering badges that were previously
  collapsed). The backend now omits absent stats (matching the `?: number`
  frontend contract) and the badge guards `!= null`; `formatBytes`/`formatCount`
  additionally bail on non-finite input.
- **Opening or closing the side cell-editor no longer resets the Schema /
  Workspace split.** The side-editor docks as a sibling in the
  `[Schema | Workspace | Cell]` row, and dockview redistributes freed/taken
  space proportionally across _all_ siblings when a child is added or removed —
  silently resizing the Schema panel each time. The Schema width is now
  remembered while the side-editor is absent and re-asserted on every
  open/close, so only the Workspace panel absorbs the change.
- **Duplicating a MySQL row with a `BIT` column then saving could fail with
  "Data too long for column".** The 0/1 control showed the normalized value but
  left the draft cell holding the raw duplicated value; if that value wasn't
  already exactly `"0"`/`"1"` (e.g. a duplicated `"true"`, or a legacy `BIT(1)`
  cell carrying a wider/garbage integer), the raw value was what got committed,
  and `CAST(? AS UNSIGNED)` into `BIT(1)` then overflowed. The control now syncs
  the committed cell to the displayed `0`/`1` on mount.

## [1.0.10] — 2026-06-11

### Added

- **Run a whole buffer of statements at once.** Pressing `Ctrl+Enter` (or the
  new "Run all (N)" button) on an editor holding several `;`-delimited
  statements — e.g. a batch of INSERTs copied from the grid — now runs them in
  order on a single connection and shows a per-statement summary, with the last
  SELECT's rows in the grid. Previously the whole buffer was sent as one
  prepared statement, which the driver rejected ("cannot insert multiple
  commands into a prepared statement"). Running them on one connection also
  means an explicit `BEGIN`/`COMMIT` (or MySQL `USE`) now carries across the
  batch. The per-statement "▶ Run" CodeLens still runs a single statement.
- **Database selector in the query editor.** On a multi-database server
  (Postgres / MySQL) the query tab now has a database dropdown: pick a database
  and the query runs against it — and the autocomplete switches to its tables —
  without typing `USE`/a schema prefix into the SQL. Backed by the existing
  per-database child pools. SQLite (single file) shows no selector.
- **Theme and editor previews in Preferences.** Appearance shows a small mock of
  the app chrome plus colour swatches painted with the selected theme; Editor
  shows a sample SQL snippet rendered with the chosen font, size, wrap and
  Monaco theme colours.
- **Fullscreen toggle in the side cell editor**, matching the modal editor
  (`F11` / `Esc`, or the header button).
- **Dedicated 0/1 control for `BIT` columns** in the insert draft row and inline
  cell editing (MySQL). It emits the numeric value the column expects and labels
  the options per the grid's BIT-display preference, instead of a text field
  that looked like it wanted a boolean.

### Changed

- **Connections opened from the CLI are now temporary.** An ad-hoc connection
  launched with `--host …` is kept in memory for the session (so the explorer
  and tabs work normally, marked "temp") but is no longer written to
  `profiles.json`, so it doesn't pile up across launches. Profiles created in
  the app still persist as before.
- **Driver badge tiles are theme-aware** — the brand logos keep their colours
  but the tile/ring now track the active theme instead of a hardcoded white
  square that clashed with dark themes.

### Fixed

- **A large `LONGTEXT` (e.g. a big JSON document) in MySQL rendered as a hex
  dump.** When the server flags a text column as binary (charset/collation
  dependent), sqlx reports it as `LONGBLOB` and `try_get::<String>` rejected it
  on a type-compatibility check _before_ looking at the bytes, so the value fell
  through to hex regardless of content. We now read the raw bytes and validate
  UTF-8 ourselves, so valid-UTF-8 text decodes as text.

## [1.0.9] — 2026-06-09

### Fixed

- **Opening a specific database failed with "no stored password for keychain
  account" when the password came from the CLI.** Expanding a database in the
  tree spins up a child pool (`open_database_view`) that re-resolved the
  credentials from the OS keychain — but a password passed via `--password`
  (or the connect dialog) lives only in memory and was never stored there. The
  backend now keeps a session-only, in-memory cache of the secret used at
  connect time (keyed by profile, cleared on disconnect); child pools reuse it
  and only fall back to the keychain when nothing was cached.

## [1.0.8] — 2026-06-09

### Added

- **Configurable default database driver** (Settings → General). Used when a
  connection is created without an explicit driver: a CLI launch without
  `--driver`, and the initial driver of the "New connection" form. It defaults
  to **"Ask each time"** — so a CLI ad-hoc launch (`--host …`) with no `--driver`
  and no configured default now pops a driver picker (and nudges you to set a
  default) instead of silently assuming PostgreSQL and mismatching a MySQL
  server.

### Changed

- **`--driver` now accepts aliases and is case-insensitive** (`MySQL`, `MYSQL`,
  `mariadb` → mysql; `postgresql`, `pg`, `psql` → postgres; `sqlite3` → sqlite).
  An unrecognized value no longer silently falls back to PostgreSQL — it routes
  to the driver picker.
- **Connection failures caused by a mismatched driver now explain themselves.**
  When a wire-protocol error indicates the wrong backend (e.g. the Postgres
  driver reading a MySQL handshake — "Postgres protocol error … unknown
  transaction status"), the error message now suggests switching the driver,
  in the Console and in the connect dialogs.

## [1.0.7] — 2026-06-08

### Fixed

- **Connections with SSL off failed during the TLS negotiation** ("unexpected
  response from SSLRequest"). With the SSL box unchecked the connection URL
  carried no `sslmode`, so sqlx fell back to its `prefer`/`PREFERRED` default —
  which still sends a Postgres `SSLRequest` (or negotiates MySQL TLS) and chokes
  against servers or poolers that don't speak it. The SSL toggle is now
  explicit: off → `sslmode=disable` / `ssl-mode=DISABLED` (straight to a
  plaintext startup, no negotiation), on → `require` / `REQUIRED`. A server that
  genuinely requires TLS now fails with a clear "enable SSL" error instead of a
  cryptic handshake byte.

## [1.0.6] — 2026-06-08

### Fixed

- **CLI `--flag=value` syntax was ignored.** The startup-arg parser only
  accepted the space-separated form (`--password secret`); the equals form
  (`--password=secret`) didn't match the flag and the value was silently
  dropped — so an ad-hoc launch like
  `huginndb.exe --host … --password=…` created the profile but reported "no
  --password given". The parser now accepts both forms for every flag
  (splitting on the first `=` so values containing `=` survive), with unit
  tests covering both spellings.

## [1.0.5] — 2026-06-08

### Changed

- **The connection dialog is now a master/detail manager** (same layout as the
  preferences dialog): a left rail lists every saved connection with a live
  "connected" dot and a "New connection" entry, and the right pane edits the
  selected profile via the General / SSH-tunnel tabs. The footer carries Test,
  Connect (save + open the pool), Delete (honoring `confirmDestructive`) and
  Save. Opening from the sidebar's `+`/edit still works; connecting from the
  manager focuses the connection in the main view. Import/export profiles live
  in the manager header, and File → "Manage connections" now opens this manager
  (focused on the current connection) instead of the old list-wrapper modal,
  which has been removed.

### Added

- **Official database logos replace the driver initials.** Connection lists,
  the file menu, the status-bar dropdown and the connection manager now show the
  PostgreSQL / MySQL / SQLite brand marks (bundled locally, no CDN) on a light
  tile so the darker logos stay legible on both themes.
- **The app logo now tops the empty-workspace welcome screen**, above the
  "huginndb — select or create a connection" hint.
- **The active connection is now visible at a glance.** The status-bar
  connections control shows the current connection's name and logo (instead of a
  bare count), and both that dropdown and the File menu mark the connection in
  focus with a check.
- **Cell preview panel can be turned off.** A new `grid.cellPreview` preference
  (Settings → Data grid) controls whether the floating value-preview panel
  appears when a cell is selected. With it off, single-click stays pure
  navigation; the heavyweight editor remains reachable via double-click and the
  context menu. Defaults to on (the historical behaviour).
- **`grid.truncateLongTextAt` is now exposed in Settings** and actually applied:
  the grid caps a cell's rendered text at the configured number of characters
  (0 disables) so a multi-MB value can't bloat the DOM. The full value is still
  available in the preview/editor.

### Fixed

- **Several preferences were silent no-ops.** Audited every toggle and wired up
  the ones that weren't being honored:
  - `grid.nullDisplay` — the configured NULL string now renders in both the data
    grid and the cell-preview panel (previously hard-coded `NULL`).
  - `grid.zebraStripes` — alternating row backgrounds are applied (was ignored).
  - `grid.stickyHeader` — the column header only pins when enabled (was always
    sticky).
  - `grid.defaultPageSize` — new table tabs open at the configured page size
    (was hard-coded to 100); the page-size dropdown includes custom values.
  - `ui.queryHistoryLimit` — the query-history ring buffer honors the configured
    size (was hard-coded to 50).
  - `ui.confirmDestructive` — turning it off now actually skips the delete
    confirmations (delete connection, delete saved query, delete rows); the
    type-the-name `DROP TABLE` guard intentionally stays regardless.
- **Ctrl+S in the docked side editor didn't clear the unsaved-changes guard.**
  When a cell was selected with the side panel open, the floating cell-preview
  panel was the one catching Ctrl+S and persisting _its_ stale (pre-edit) value,
  so the side panel's edits weren't saved and its dirty baseline never reset —
  moving to another cell then popped the discard-changes dialog. The side panel
  now owns Ctrl+S (capture phase, taking precedence over the preview): it saves
  its own buffer in place, resets the baseline, and keeps the panel open so you
  can move on without the prompt.
- **The Console detail editor ignored the editor preferences.** It now follows
  the configured Monaco theme, font family and font size instead of the app
  light/dark mode and a fixed font.
- **CLI auto-connect did nothing for ad-hoc launches and failed silently.** The
  startup-arg handler was gated on having at least one saved profile, so
  `--host/--port/--database/--driver/--user/--password` launches were skipped
  entirely on a profile-less machine; it also swallowed every error, so a
  mistyped profile name or a failed connect produced no feedback. The handler
  now runs once on boot regardless of the profile list, awaits a profile
  refresh before matching `--connect-profile` by name/id, and reports failures
  (profile not found, connect error, ad-hoc setup) in the Console panel. The
  backend additionally echoes the parsed flags to stderr on launch (password
  redacted) so a terminal launch can confirm the args arrived.
- **SSH tunnel didn't fall back when the pinned local port was held with
  exclusive access.** The bind-collision fallback only recognised `AddrInUse`;
  on Windows a port held by another tunnel/socket opened for exclusive use — or
  inside a reserved range (Hyper-V/WSL `netsh` reservations) — surfaces as
  `WSAEACCES` (`PermissionDenied`), which slipped through and broke the
  connection. The fallback now also covers `PermissionDenied` and
  `AddrNotAvailable`, retrying on an OS-assigned port. The reassignment is
  logged to the Console (not just stderr) so it isn't invisible.

## [1.0.4] — 2026-06-06

### Added

- **CLI `--password`/`--pass` flag and `--user` alias.** The password can now be
  supplied on the command line for both `--connect-profile` (overriding the
  stored keychain secret) and ad-hoc launches; when present the app
  auto-connects without the password dialog. The password is used **in memory
  only** — it is handed straight to `connect` and never written to the OS
  keychain. `--user` is accepted as an alias for `--username` to match the
  spelling used by `psql`/`mysql`.

### Fixed

- **Main panel titles stayed in English under a Spanish UI.** The outer dockview
  panels (Schema, Saved, Workspace, Console, Cell) had hard-coded English
  titles, baked into the persisted layout, so they never followed the selected
  language. Titles are now sourced from i18n, re-applied after a layout restore,
  and updated live when the language changes. The View → Panels checkboxes use
  the same translated labels. Inner workspace tab fallbacks (the `Query`/`Table`
  default labels and the `(structure)` suffix on structure-editor tabs) are now
  localized too.

- **MySQL `LONGTEXT`/`TEXT` rendered as a hex blob.** sqlx names a column
  `LONGBLOB`/`BLOB` (vs `LONGTEXT`/`TEXT`) from the protocol-level `BINARY`
  column flag, which the server sometimes sets on real text columns depending
  on charset/collation — so a `LONGTEXT` field could surface as a hex dump
  (HeidiSQL showed it as text). The decoder now tries a UTF-8 `String` decode
  first and only falls back to hex for genuinely non-UTF-8 bytes.

- **SSH tunnel broke when the configured local port was already in use.** If
  another process (e.g. a second tunnel the user opened by hand) held the
  pinned `local_port`, the bind failed with `AddrInUse` and the connection
  errored out. The tunnel now falls back to an OS-assigned ephemeral port and
  keeps working; the pool follows the actually-bound port and the saved profile
  is left untouched.

- **SSH tunnel form fields overflowed the dialog.** When reconfiguring an
  existing tunnel, long values (notably the private-key path) pushed inputs and
  the "Browse" button past the dialog edge. Added `min-w-0`/`flex-1`/`shrink-0`
  constraints so fields shrink within the dialog instead of overflowing.

- **MySQL `BIT` column write — `insert_row` path.** `RowValue` now carries an
  optional `column_type` field. When the frontend builds the draft-row INSERT
  payload it populates `columnType` from `result.columns`, and the backend
  builds `CAST(? AS UNSIGNED)` placeholders for every MySQL `BIT` column
  instead of plain `?`. Previously, binding a string like `"1"` to a `BIT`
  column stored the ASCII byte `0x31` (49) rather than the integer 1 — for
  wide `BIT(n)` columns this silently wrote the wrong value every time.

- **MySQL `BIT` column write — `update_cell` path.** Added
  `normalize_bit_value` preprocessing so that the string handed to
  `CAST(? AS UNSIGNED)` is always a digit string. Without this, if the cell
  editor produced `"true"` or `"false"` (e.g. after the user typed those words
  in the Monaco editor), MySQL would evaluate `CAST('true' AS UNSIGNED)` as 0
  regardless of the intended bit value.

## [1.0.3] — 2026-06-03

### Added

- **Command palette hint in the status bar.** A small `Ctrl+K` chip now sits
  in the bottom-right status bar. Clicking it opens the command palette
  directly; hovering shows the full tooltip ("Command palette (Ctrl+K)"). The
  label uses a dynamic import so it never blocks the status bar render.

- **Command palette (`Ctrl`/`Cmd`+K).** A keyboard-first launcher for the
  actions otherwise buried in menus: switch or connect a database, open a table
  from the active connection's schema, start a query, switch theme or language,
  and open Preferences. Built on the bundled Radix dialog plus a filtered list —
  no new dependency. Because Monaco swallows `Ctrl`+K inside the editor, the
  query editor registers its own editor-scoped command so the palette opens
  regardless of focus (gotcha #9).
- **Active-connections dropdown in the status bar.** The comma-joined list of
  open connections is now a dropdown: live pools at the top (click to jump to
  that workspace, or disconnect inline), saved-but-idle profiles below for
  quick-connect. Connect / disconnect mirror the File menu flow exactly.
- **Richer status bar.** Adds a live multi-row **selection count**, a
  **read-only** marker for query-result tabs, a clickable **query-history**
  popover (open a recent query in a fresh tab, or copy it when its connection is
  offline), and quick **row-density** and **light/dark** toggles.
- **"What's new" patch notes in Preferences → About.** A per-version reader
  sourced from the bundled `CHANGELOG.md`, defaulting to the installed version.
  When the UI language is Spanish it reads a parallel `CHANGELOG.es.md`, falling
  back to the English body for any version not yet translated.
- **Active database marker in the multi-DB explorer.** When the schema-explorer
  filter is scoped to a database (the HeidiSQL-style behaviour shipped in 1.0.2),
  that database now carries an emerald dot and icon while the other databases are
  dimmed, so it's obvious at a glance which database the filter will hit — no
  longer only inferable from the filter input placeholder. With no database
  active (cross-DB / MongoDB-style search) every database stays at full opacity,
  since they're all in scope.

### Changed

- **Themeable brand accent.** The previously all-neutral palette gains one
  saturated accent colour reserved for action / state — primary buttons, focus
  rings, links, and the live-connection markers. It's a per-theme `brand` token
  (themes.ts): the neutral Dark / Light presets get a blue (`#0f83fd`) while the
  themed presets (Claude, Solarized, Dim, High Contrast) keep their own
  character. Custom themes saved before the token existed inherit a CSS default
  rather than breaking. A `prefers-reduced-motion` rule collapses the UI's
  transitions for users who ask for less motion.
- **"Island view" window layout.** The outer panel shell (Schema / Saved /
  Workspace / Console) now lays its panels out as spaced, rounded cards over a
  subtle backdrop instead of edge-to-edge regions, giving each window a small
  margin and clearer separation. The inner tab area (open tables and queries)
  stays flush and unchanged.

### Fixed

- **Duplicate "▶ Run" CodeLens (and duplicate autocomplete entries) with
  multiple query tabs open.** Monaco's `registerCompletionItemProvider` /
  `registerCodeLensProvider` / `registerCommand` are global to the language,
  but they were registered inside every query editor's `onMount`, so each open
  query tab added another provider — N tabs produced N "▶ Run" lenses on every
  statement and N copies of each suggestion. The providers are now installed
  once per Monaco instance (`src/lib/monacoSql.ts`) and dispatch per model via a
  registry each editor registers into on mount and removes on unmount.
- **Inner workspace tab strip readability + active-tab tracking.** The active
  query/table tab now carries a brand-tinted accent and tracks the active panel
  correctly (the custom tab derives its active state from the store rather than
  a stale `props.api.isActive`), the strip is taller with clearer hover states,
  and the close / split (⋮) / new-query (+) icons are legible on dark themes.
- **Incomplete Spanish translation.** Several panels and dialogs still rendered
  English regardless of the selected language. Migrated the Console panel, the
  query editor (history sidebar, tooltips, empty states, run hints), the Saved
  Queries panel, the Save Query dialog, the inline cell input, the connection
  error boundary, the data-grid right-click context menu (copy, copy-row-as,
  set NULL, filter by / excluding value, insert / duplicate / delete row, and
  the multi-row bulk actions), the data-grid toolbar (row filter, row count,
  insert, server-side filter chips) and the table browser toolbar (refresh,
  pagination, page size, loading state and the delete-confirmation dialog) to
  the i18n system. Spanish now covers the whole UI.

## [1.0.2] — 2026-06-02

### Added

- **Import / Export of connection profiles.** Export all or selected profiles to
  a portable JSON file (`File → Export profiles…` or the icons in _Manage
  connections_). Profiles can optionally include credentials: each password and
  SSH secret is encrypted individually with AES-256-GCM, key-derived via
  PBKDF2-HMAC-SHA256 at 600 000 iterations, so the file is safe to store or
  send. Importing detects encryption, walks through a passphrase step when
  needed, shows a conflict-resolution screen when IDs collide (overwrite / skip /
  keep both), and always assigns fresh UUIDs to imported profiles to avoid
  keychain collisions. Profiles imported without passwords are flagged in the
  result summary.
- **CLI connection arguments.** HuginnDB can now be launched with connection
  flags so external tools can open it pre-connected. `--connect-profile <name>`
  auto-connects to a saved profile by display name; `--connect-profile-id <uuid>`
  uses the stable ID instead. For ad-hoc connections without a saved profile:
  `--host`, `--port`, `--database`, `--username`, `--driver`, `--name` — the
  app opens with the profile pre-populated and asks for the password via the
  normal dialog (passwords are never accepted on the CLI). Unknown flags are
  silently ignored for forward compatibility.
- **Scoped multi-DB filter (HeidiSQL-style).** In multi-database connections,
  the schema-explorer filter now scopes to the active database instead of
  searching all databases simultaneously. Expanding a database activates it as
  the filter scope; the search input placeholder updates to "Filter in
  `<db>`…" and a hint below the input confirms the scope while typing. Opening
  a table from cross-DB results automatically activates that database, collapses
  the others, and fixes the scope. With no database expanded the filter falls
  back to the previous behaviour (searches all DBs), keeping the single-DB case
  fully retrocompatible.
- **Visual table-structure editor (HeidiSQL-style).** Right-click a table →
  _Edit structure…_ (or _New table…_) opens an editor for columns
  (add/drop/rename, type, nullability, default, primary key, auto-increment),
  indexes and foreign keys — including composite ones. The column type is an
  editable combobox pre-filled with the driver's common types so you avoid
  typos but can still fine-tune (e.g. `varchar(40)`). It follows a
  preview-and-apply model: the backend generates driver-aware DDL (PostgreSQL /
  MySQL / SQLite) which is shown in a live read-only preview before you apply it
  in one go. On SQLite, changes that `ALTER TABLE` can't express (type /
  nullability / PK / FK edits) fall back to the canonical 12-step table rebuild,
  gated behind an explicit destructive confirmation. All identifiers are
  validated before quoting; types and defaults go through a conservative
  allowlist.
- **Side-panel cell editor (JetBrains-style).** Large cell values can now be
  edited in a docked right-side panel instead of a centered dialog. Reach it via
  right-click → _Open in side editor_, or the new _Move to side panel_ button
  inside the modal editor (it carries the in-progress buffer across). A new
  _General → Cell editor_ preference (`cellEditorMode`: Dialog / Side panel)
  chooses where the editor opens when you expand a cell. The panel is a real
  dockview panel, so it resizes, docks and floats like the others.
- **Multi-row selection with bulk copy and delete.** Pick several rows the way
  your OS file manager works: `Ctrl`/`Cmd`-click toggles individual rows and
  `Shift`-click extends a contiguous range. Right-clicking the selection offers
  _Copy N rows as ▸ JSON / SQL INSERT / SQL UPDATE_ (reusing the existing per-row
  formatters) and _Delete N rows_. Every delete — single or bulk — goes through
  the same confirmation dialog. Selection is keyed by primary key, so it
  survives sorting, client-side filtering and refetches (only available on
  tables with a primary key).
- **Workspace split/float layout now persists per connection.** A two-pane (or
  floating) arrangement inside a workspace is captured as a dockview `toJSON()`
  blob in `tab_state.json` (`internalLayout`) and restored with `fromJSON` on
  reopen, instead of always coming back as plain tabbed panels. Only saved when
  a split actually exists; on any layout drift it falls back to the tabbed
  default.

### Fixed

- **Editing a MySQL `BIT` cell wrote garbage.** `update_cell` sends the value
  as a textual literal and lets the driver coerce it. For `BIT`, MySQL reads the
  string `"1"` as the ASCII byte `0x31` (the character `'1'`) instead of the
  integer 1, so saving a BIT cell silently corrupted it — while `VARCHAR`/`TEXT`
  worked because they accept the string directly. The frontend now forwards the
  column's raw type to `update_cell`, which wraps the placeholder in
  `CAST(? AS UNSIGNED)` for MySQL `BIT` columns (NULL-safe), forcing numeric
  interpretation. PG/SQLite are unchanged.
- **MySQL `TINYINT` (and other non-`i64` integer widths) rendered as `NULL`.**
  sqlx maps each MySQL integer width to a specific Rust type (`TINYINT` → `i8`,
  `… UNSIGNED` → `u8`/`u32`/`u64`, …) and refuses a mismatched `try_get` target,
  so `try_get::<i64>` failed for everything that wasn't signed-64-bit-compatible
  and the cell collapsed to `NULL` — the same class of bug previously fixed for
  `BIT`. `mysql_value` now falls back across the signed and unsigned widths
  before surrendering to `NULL`, so `TINYINT`/`SMALLINT` and unsigned columns
  show their real value. `TINYINT(1)`/`BOOL` still decode as booleans (that
  branch stays above the generic `INT` check).
- **Blank connection panel when clearing a multi-DB filter.** In a multi-database
  connection, typing a filter and then clearing it could blank the entire schema
  panel (the outer File/View/Workspaces toolbar stayed visible). Root cause: a
  `useMemo` in the single-database explorer sat _below_ the `if (!cs) return`
  early return, so when the per-connection schema slice briefly flipped to
  `undefined` while nested explorers unmounted, React rendered a different number
  of hooks across renders and threw. The hook now sits above the early return
  (constant hook count) and the grouping is reference-stable. A new
  `ConnectionErrorBoundary` wraps the schema and workspace panels so any future
  render crash degrades to a legible error card with a retry instead of a dead
  white screen.

## [1.0.1] — 2026-05-30

First patch release. Fixes the MySQL `BIT` rendering that 1.0.0 shipped
broken, and reworks data-grid cell editing into an inline-first flow with a
persisted HeidiSQL-style row zoom. On-disk state is untouched.

### Added

- **Inline cell editing.** Double-clicking a cell in the data grid now edits
  it in place with the same single-line input used by the insert draft row,
  instead of always opening the large Monaco dialog. A _expand_ button on the
  inline editor (and the existing F11 in the cell preview) escalates to the
  full modal for JSON / long / multi-line values. Foreign-key columns keep
  their inline combobox; read-only query results still open the modal as a
  viewer. The plain input + `∅` set-NULL control is now a shared `CellInput`
  component reused by both the draft row and inline editing.
- **Persisted row zoom.** The data grid honours `gridPrefs.rowHeight` (a
  HeidiSQL-style zoom): `Ctrl` + mouse-wheel over the grid and `+`/`−` buttons
  in the table toolbar grow or shrink row height, padding and font-size
  together. The level is stored in `prefs.json` and survives restarts.

### Fixed

- **MySQL `BIT` columns rendered as `NULL`.** `sqlx` refuses to decode a
  `Vec<u8>` from a `MYSQL_TYPE_BIT` column (its blob type-compatibility check
  only accepts BLOB/STRING/VARBINARY), so the value collapsed to `NULL` in the
  grid even though the row held a real value. `mysql_value` now reads the bytes
  straight off the `ValueRef`, folding them big-endian into an integer
  (`BIT(1)` → 0/1, wider `BIT(n)` → its numeric value). Booleans
  (`BOOL` / `TINYINT(1)`) are also now decoded before the generic `INT` check,
  which previously shadowed them.

## [1.0.0] — 2026-05-29

First stable release. The alpha cycle (0.x) closes with the workspace
turning into a code-editor-style surface, the multi-database explorer
becoming instant on the first keystroke, and two MySQL-specific defects
fixed. Existing data on disk (`profiles.json`, `tab_state.json`,
`prefs.json`) is preserved without migration. From here on the project
follows SemVer.

### Added

- **Editor-style workspace.** The open table and query tabs now live in a
  nested dockview instance instead of a flat tab strip, so the workspace
  behaves like a code editor: tabs can be split horizontally or
  vertically, dragged between groups, and torn out into a floating
  window. Tabs can also be closed with a middle-mouse (wheel) click in
  addition to the X button. Each tab also exposes an explicit `⋮` menu
  with _Split right_, _Split down_, _Float in new window_, and _Close_
  for users who prefer menu actions over drag-and-drop. `useTabs` remains
  the source of truth — the dockview panels are reconciled against it —
  so the existing per-connection tab restore keeps working. Split/float
  geometry is session-only; restored tabs come back in the default tabbed
  layout.

- **MySQL `BIT` columns are now configurable in the grid.** A new
  **BIT display** preference (Settings → Grid) renders `BIT` values as
  either `true`/`false` (default) or `0`/`1`. The backend always ships
  the value as a number, so toggling the preference re-renders without
  re-querying.

### Changed

- **Multi-database filtering is now instant.** The connection-level
  filter used to fan out `openDatabaseView` + `list_tables` across every
  database on the _first_ keystroke, so the initial search on a server
  with many databases stalled for seconds. A multi-DB connection now
  warms its entire table cache in the background as soon as the database
  list is known (`warmDatabases` in `src/stores/schema.ts`), with bounded
  concurrency so it never opens every pool at once. The filter reads
  straight from that cache; a subtle progress line shows how many
  databases remain. The previous on-demand prefetch is retained as a
  fallback for databases the warm pass hasn't reached yet.

### Fixed

- **HTML5 drag-and-drop in the workspace was completely broken on
  Windows.** Dragging an editor tab produced the "no drop allowed"
  cursor everywhere on screen — no drop overlay appeared, nothing
  accepted a release. Tauri 2's `dragDropEnabled` defaults to `true`,
  which routes drag events through the OS file-drop handler and preempts
  the HTML5 events dockview's `Droptarget` listeners rely on
  (`tauri-utils` documents this verbatim: _"Disabling it is required to
  use HTML5 drag and drop on the frontend on Windows"_). The window
  config now sets `dragDropEnabled: false`. HuginnDB doesn't accept OS
  file drops anyway (the SQLite path is chosen via a file dialog), so
  there's no functional loss.

- **Split divider between dockview groups was nearly invisible.**
  `.dv-sash` was forced to z-index 1 (so Radix portals always covered
  it) and tinted with `--border`, which on the dark theme blended into
  the panel content. A vertical split looked like nothing had happened
  even when dockview had laid out a new group below. The sash now lives
  at z-index 10 (still safely under Radix at 50) with an explicit
  divider tint, and the drag-over fill jumped from 0.18 to 0.40 alpha so
  the drop quadrants stand out over Monaco / grid surfaces.

- **"Split right" / "Split down" actions in the tab `⋮` menu silently
  did nothing.** They called `panel.api.moveTo({ position })` without a
  `group`, but `DockviewPanelApiImpl.moveTo` coerces `position` to
  `"center"` whenever `options.group` is undefined — moving the panel
  to the centre of its own group is a no-op. Passing the panel's own
  group as the reference makes dockview create a new group adjacent at
  the requested side.

- **MySQL/MariaDB raised error 1064 when filtering a table.** The
  cross-column search clause emitted `... LIKE ? ESCAPE '\'` for every
  driver. On MySQL the backslash inside the string literal escapes the
  closing quote, leaving it unterminated and triggering a syntax error
  (the filter still returned rows because the data and `COUNT(*)`
  queries run separately, but the error banner appeared). The `ESCAPE`
  clause is now driver-aware: MySQL receives `ESCAPE '\\'` (parsed as a
  single backslash, matching `escape_like`), while Postgres/SQLite keep
  the standard-SQL `ESCAPE '\'`. Centralised in a new
  `like_escape_clause` helper used by both the table filter and the FK
  options lookup (`src-tauri/src/commands/query.rs`).

- **MySQL `BIT` columns rendered as NULL.** `mysql_value`
  (`src-tauri/src/db/values.rs`) had no branch for `BIT`, so sqlx's
  binary value fell through to the `String` fallback, failed to decode,
  and surfaced as NULL. A dedicated branch now folds the raw bytes into
  a big-endian unsigned integer and ships it as a number.
