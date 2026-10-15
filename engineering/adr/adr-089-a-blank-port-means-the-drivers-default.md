---
id: 89
type: adr
status: accepted
date: 2026-09-18
tags: [mssql, ssh]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #89: A blank port means the driver's default, and `tiberius` aims its SQL Browser lookup at whatever port the `Config` carries

A profile's `port` of `0` is not port zero — it is "the user did not choose one", the value a blank port field, a `--port`-less CLI launch and an imported profile all produce. Everything that dials or prints a port resolves it through `ConnectionProfile::effective_port` (frontend: `effectivePort`), and nothing rewrites the stored profile. Separately, and the reason this was found at all: `tiberius`' `connect_named` sends its SQL Browser datagram to **`Config::get_addr()`**, so handing it the login config aimed every named-instance lookup at the instance's own TCP port, where no UDP listener has ever been.

**External trap behind it:** tiberius' connect_named sends the SQL Browser datagram to Config::get_addr(), so a config carrying the login port aims the lookup at the instance's TCP port where no UDP listener exists; until 1.27.0 the Browser path never worked.

**Decision:** A stored port of 0 means 'driver default', resolved through ConnectionProfile::effective_port at connect time (before the SSH branch) and never written back; SQL Browser discovery uses a cloned config moved to SQL_BROWSER_PORT.

**Alternatives rejected:**

- Filling the default into the field on save (what HeidiSQL does) — rejected because profiles.json would record a number the user never typed and shared origins would propagate it.
- Resolving the port inside build_url — rejected because the SSH tunnel would still forward to host:0.
- Keying EndpointKey on the raw port field — rejected because two profiles for one server would get two budgets.

## Detail

**`0` is free to mean "default" because nothing can listen on it.** Both sides resolve it and neither persists the resolution: `Driver::default_port()` in `state.rs` and `DEFAULT_PORTS` in `src/lib/constants.ts` hold the same five numbers for the same reason they always did — the dialog *prefills* with its copy when you pick a driver — but the backend copy now also decides what a profile carrying no port connects to, which matters precisely for the profiles the dialog never touched: CLI ad-hoc launches, imported `.json` files, and profiles arriving from a shared origin.

**Resolving at connect time rather than at save time is the whole design decision.** Filling the default into the field on save (what HeidiSQL does) is simpler and was rejected: `profiles.json` would then record a number the user never typed, a shared origin would propagate it to every consumer, and the profile would be pinned to today's default if it ever moved. Storing the zero keeps the file honest about what was chosen.

**SQLite answers `0` and that is not a special case to guard.** It has no server, `Driver::default_port()` returns `None`, and no SQLite path reads the field — `EndpointKey::for_profile` returns `None` for it before a port is ever consulted.

**The resolution has to happen before the SSH branch, not inside the URL builder.** A tunnel's *remote* port is as real as the one a URL names, so `open_pool` (and `mssql::open_pool`) resolve once into a `remote_port` local that both branches read. Doing it in `build_url` would have fixed the direct connection and left `ssh::open_tunnel` forwarding to `host:0`.

**`EndpointKey` keys on the resolved port, or two profiles for one server get two budgets.** A profile with a blank port and one that spells `5432` out are the same endpoint; keying on the raw field would let the pair open twice the ceiling that gotcha-era accounting exists to bound (`crate::db::endpoint`).

**`tiberius` reads the Browser lookup's destination off the same `Config` as the TDS login.** `connect_named` calls `lookup_host(builder.get_addr())` and sends the SSRP datagram to *that* address, only rewriting the port once the Browser has replied. `build_config` has always called `cfg.port(port)` — it must, because that port is what `Reach::Browser`'s fallback connects to — so the lookup went to TCP 1433 (or, for a blank port, to port 0), timed out after `tiberius`' own one second, and fell through. The consequence is worth stating plainly: **until 1.27.0 the SQL Browser path never worked at all**; every named instance that connected did so through the static-port fallback, and any instance on a dynamic port could not connect by any route. The symptom that exposed it is the tell — typing `1434`, the *Browser's* port, into the port field made the connection work, because that is the only value that made the datagram land where it was addressed.

**`discovery_config` is a named function rather than two inline lines so a test can state the rule.** It clones the login config and moves its port to `SQL_BROWSER_PORT`; the login below still uses the original, so the typed port keeps serving as the fallback target. `tiberius` exposes `Config::get_addr()` publicly and `get_port()` only within its crate, which is why the test asserts on the address string.

**A port equal to the default is still not a fallback signal.** `fallback_port` stays `None` for `1433`, blank or typed: retrying it after the Browser went quiet buys a second connect timeout and nothing else. The condition lost its `&& port != 0` arm only because a zero can no longer reach `build_config`.

**The dialog's placeholder is the feature's only UI.** The port field shows the driver's default in grey when empty, so leaving it blank reads as a choice with a known outcome rather than as an unfinished field. `ConnectionRailRow` prints the resolved port for the same reason — a row reading `SVRSQL3:0` names a port nothing listens on.
