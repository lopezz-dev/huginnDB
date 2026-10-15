---
id: 103
type: adr
status: accepted
date: 2026-09-28
tags: [updater, windows, mcp]
triggered_by_external_trap: false
related: [24, 102]
supersedes: []
superseded_by: null
amends: []
---

# ADR #103: The headless updater installs unattended, branches off before the Builder, and is launched in layers

`huginndb.exe --update=<logon|daily>` checks the signed feed with no window and installs with no click, unlike the interface (ADR #24). It is detected at the top of `run()` before `tauri::Builder`, runs `tauri-plugin-updater` on a minimal app built from the real context with its windows removed and the installer set to `quiet`, and waits only when installing would take something from a person right now. Task Scheduler launches it; where the domain refuses a layer, the next one covers it, and where it refuses all of them the app says so.

**Decision:** `huginndb.exe --update=<logon|daily>` checks the signed feed and installs quietly without a window, waiting only when the interface is open (or the connector is in use on the daily run), launched by two per-user scheduled tasks with an HKCU Run fallback, on by default, with the MCP connector reading a recorded 'available' notice instead of contacting the feed.

**Alternatives rejected:**

- Relying only on the in-app click-to-install updater (gotcha #24) — insufficient because the target users never open the app.
- Branching in parse_args — rejected because AppState::new_with_args writes state and the single-instance plugin forwards the process.
- The updater's `passive` install mode — rejected because it shows a progress window; `quiet` is used.
- schtasks /SC ONLOGON or a task subfolder — not usable because they need an administrator; XML tasks in the root folder are used.
- Retrying a refused schedule another way — rejected; a customer's restriction is reported, not worked around.
- Having the connector query the feed itself — rejected because it would break the .mcpb's privacy statement.
- An opt-in default — rejected because it would reach none of the people it is for.

## Detail

**Why an unattended install at all, against ADR #24.** The in-app updater never installs without a click, because `install()` overwrites files, kills the MCP sidecar and closes the app — for someone *using* HuginnDB, that must be their decision. The users this exists for never open it: they use the connector through an AI client, and since the `.mcpb` hands its sessions to the installed connector (ADR #102), that connector is only ever as new as the app. A button they will never see updates nobody. ADR #24 still governs the interface; this path has its own rule, `updater::decide`: an open interface always waits (`AppOpen` — the installer would close it with the user's work in it, and its own updater already offers the update); a running connector waits only on the daily run (`ConnectorInUse`); at logon, and on a manual `--update`, it installs over a running connector, because logon is the least disruptive moment there is and a rule that let an always-open AI client block every update would leave exactly these machines behind for good. When the connector is killed the client loses it and the user restarts the client — the accepted plan B.

**Branched before the Builder, not in `parse_args`.** `AppState::new_with_args` writes state (it can migrate `tab_state.json` and rewrite `profiles.json`), and the single-instance plugin forwards a second process to the open window and brings it to the front. So `run()` checks `updater::request_from` first and exits with `updater::headless::run`'s code; nothing but `prefs.json` is read. The context comes from one `fn context()` shared with the interface so `generate_context!` expands once. `prepare` clears `app.windows` and writes `plugins.updater.windows.installMode = "quiet"` into the context before `build()` — the plugin reads its config at setup, and `passive` shows a progress window. The app is built but never run: the updater needs a handle, not an event loop. The feed, the minisign key and the signature check are the interface's own.

**The installer relaunches the app with the same arguments.** On Windows the plugin passes `/S /R /UPDATE /ARGS <current args>` and then `std::process::exit(0)`s, so a successful install is followed by `huginndb.exe --update=…` again. That second run finds nothing newer, records `UpToDate` and exits. `Installing { version }` is recorded *before* `download_and_install`, because a successful call never returns.

**One run at a time.** The logon task and a `Run` value left from an earlier refusal can fire together, and the second would count the first as an open interface. An exclusive `share_mode(0)` open of `updater.lock` is the lock; Windows releases it however the process ends. "Is the interface open" is `tasklist` for the executable's own image name excluding this pid (`updater::process::is_running`, which `is_mcp_sidecar_running` now shares), with `CREATE_NO_WINDOW` because a GUI-subsystem process otherwise flashes a console for every tool it starts. A check that cannot be made reads as "not running".

**Layers, never one load-bearing mechanism.** `updater::schedule` registers two tasks for the current user from XML — a `LogonTrigger` scoped to `DOMAIN\user` (what a standard account may create; `schtasks /SC ONLOGON` needs an administrator) with a one-minute delay, and a daily `CalendarTrigger` with two hours of jitter and `StartWhenAvailable`. They live in the root folder (a subfolder needs an administrator) and are named from `productName`, so the canary's are separate. The XML is written UTF-16 with a BOM, which `schtasks /XML` reads reliably. If the logon task is refused, `HKCU\...\CurrentVersion\Run` gets a value that does the same; if the logon task later succeeds, that value is deleted so sign-in does not start two runs. Every combination has a `Mechanism` (`Tasks` … `Manual`) recorded with what Windows said, verbatim, and Settings → About prints it. Nothing retries a refusal another way: a customer's restriction is reported, not worked around.

**One implementation, reconciled from three places.** The installer's `NSIS_HOOK_POSTINSTALL` runs `--ensure-schedule` (force: the executable may have moved) and `NSIS_HOOK_PREUNINSTALL` runs `--remove-schedule`; there is no `schtasks` in NSIS. The app's startup reconciles without force (fills in only what is missing — an installer hook that failed, a task someone deleted) and so does every headless run, since recreating a task from inside a run of that same task is not something to do on every tick. `prefs::update_preferences` reconciles with force only when `updates.autoInstall` actually changed, or every slider drag would shell out to `schtasks`. A debug build never registers anything: its executable is under `target/`.

**The last layer is the connector, and it never touches the network for it.** Where every schedule is refused and nobody opens the app, an update can wait forever. `UpdaterRecord::available` holds the newest version a check has seen and since when — written by the headless run (`note_available` before `decide`, cleared on `UpToDate`) and by the interface's own check through `note_update_check` — and the MCP server's `instructions()` appends a note when `pending_notice` finds one newer than the connector (`is_newer`, numeric `major.minor.patch`, anything unparseable is *not* newer) that has waited at least `NOTICE_AFTER_MS` (a day, so a machine whose schedule works never sees it). The AI then tells the user to open HuginnDB. The connector reading a file the app wrote, rather than asking the feed itself, is deliberate: the `.mcpb`'s privacy statement is that it reaches the databases it was pointed at and nothing else, and a daily request to GitHub would have made that false. The cost, on the record: a machine where the schedule is refused, nobody ever opens the app *and* the headless run never ran gets no note either.

**On by default, for every existing install.** `UpdatePrefs::auto_install` defaults to `true` against the usual "new flags start off" rule, because an opt-in would reach none of the people it is for. No managed policy is needed; one that wants to govern updates is a later addition that narrows this, not a prerequisite.

**What it records.** `updater-state.json` (latest schedule outcome and latest run) for the interface via `get_auto_update_status`, and `updater.log`, one line per event capped at 200, because a GUI-subsystem process has no console. Both best effort. `supported` is false on a debug build or off Windows, and the card says so rather than showing a switch that does nothing.

**Not verified from here.** Whether a standard account on a locked-down domain may create the logon task, whether AppLocker allows the installer the plugin writes to `%TEMP%`, and whether the corporate proxy and TLS inspection let the feed through: the ignored test `schtasks_accepts_the_generated_tasks` proves the XML is accepted, on the account that runs it, and nothing more.
