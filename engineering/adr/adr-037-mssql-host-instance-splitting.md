---
id: 37
type: adr
status: accepted
date: 2026-08-18
tags: [mssql]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #37: SQL Server accepts SSMS's HOST\INSTANCE in either field, split centrally

`split_instance` in `db/mssql/mod.rs` is the single authoritative normalization, run before the tunnel branch is opened; `lib/db/driver.ts`'s `splitSqlServerName` is only a UI-side preview twin.

**External trap behind it:** Users type SSMS's single-box HOST\INSTANCE; unsplit, a backslash in the host breaks DNS and the whole string as an instance name never matches SQL Browser, which reports only the bare name.

**Decision:** split_instance in db/mssql/mod.rs is the single authoritative normalisation of HOST\INSTANCE (run in open_pool before the tunnel branch), with splitSqlServerName as a UI-only preview twin.

**Alternatives rejected:**

- Retrying the default port 1433 when SQL Browser is unreachable: just buys a second connect timeout, so the static-port fallback applies only to a non-1433 port.

## Detail

**SQL Server accepts SSMS's `HOST\INSTANCE` in *either* field, and `split_instance` (`db/mssql/mod.rs`) is the one place that knows it.** SSMS has a single "Server name" box, so that is the form users type; unsplit it fails two different ways (a backslash in the host breaks DNS; the whole string as an instance name can never match the SQL Browser, which reports only the bare name). The normalisation runs in `open_pool` **before** the tunnel branch — the tunnel is opened against the host — and `build_config` takes the instance as a parameter rather than reading the profile, the same contract `host`/`port` already had. `lib/db/driver.ts::splitSqlServerName` is a UI-only twin so the dialog can show the split on blur; the Rust one is authoritative (it also serves the CLI and the MCP connector). Related: `Reach::Browser` carries the static port as a fallback for a stopped/firewalled SQL Browser (UDP 1434), but only when the user set a port other than 1433 — retrying the default on a host that is dropping UDP just buys a second connect timeout.
