//! Silent updates for the workstation where nobody opens the app.
//!
//! The in-app updater (`src/stores/update.ts`) only runs while a window is
//! up, and it never installs without a click (ADR #24). That is right for
//! someone using HuginnDB, and leaves behind everyone who only uses the MCP
//! connector through an AI client: they never open the app, so they never
//! update, and since the `.mcpb` hands its sessions to the installed connector
//! (ADR #102) the connector they use is only ever as new as the app.
//!
//! This module is the other path. `huginndb.exe --update=<trigger>` runs with
//! no window, checks the same signed feed the interface uses, and installs in
//! silence unless doing so would take something away from a person right now
//! ([`decide`]). Windows' Task Scheduler launches it at logon and once a day
//! ([`schedule`]); where the domain forbids that, a `Run` value covers logon,
//! and where it forbids that too, the app says so instead of pretending
//! ([`schedule::Mechanism::Manual`]). See ADR #103.
//!
//! Windows only, like the scheduled tasks it depends on. On Linux the Tauri
//! updater only replaces an AppImage, and `.deb`/`.rpm` belong to the package
//! manager.

// Everything that decides, records and schedules is compiled everywhere so its
// tests run on every CI leg, but only the Windows headless path calls most of
// it.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
pub mod headless;
pub mod process;
pub mod record;
pub mod schedule;

use serde::{Deserialize, Serialize};

/// What launched a headless run. It changes one decision: whether an MCP
/// connector that is running right now is reason enough to wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    /// The logon task, or the `Run` value that stands in for it.
    Logon,
    /// The daily task.
    Daily,
    /// Someone ran `huginndb.exe --update` by hand.
    Manual,
}

impl Trigger {
    /// The argument that asks for this trigger, as the task and `Run` value
    /// write it.
    pub fn arg(self) -> &'static str {
        match self {
            Trigger::Logon => "--update=logon",
            Trigger::Daily => "--update=daily",
            Trigger::Manual => "--update",
        }
    }
}

/// What a command line that is not the interface asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    /// Check the feed and install if [`decide`] allows it.
    Update(Trigger),
    /// Make the schedule match the preference, recreating what exists. The
    /// installer runs this after every install, fresh or update.
    EnsureSchedule,
    /// Take the schedule away. The uninstaller runs this.
    RemoveSchedule,
}

/// The request in `args` (`argv[1..]`), if any. The first recognised flag
/// wins; everything else on the line is left to the interface's own parser,
/// which ignores what it does not know.
pub fn request_from(args: &[String]) -> Option<Request> {
    args.iter().find_map(|arg| match arg.as_str() {
        "--update" => Some(Request::Update(Trigger::Manual)),
        "--update=logon" => Some(Request::Update(Trigger::Logon)),
        "--update=daily" => Some(Request::Update(Trigger::Daily)),
        // An unknown trigger still means "update": a task written by a later
        // version must not open a window on a machine that downgraded.
        a if a.starts_with("--update=") => Some(Request::Update(Trigger::Manual)),
        "--ensure-schedule" => Some(Request::EnsureSchedule),
        "--remove-schedule" => Some(Request::RemoveSchedule),
        _ => None,
    })
}

/// Why an available update was left for later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeferReason {
    /// The interface is open. The installer would close it and take whatever
    /// the user has half done with it; its own updater already offers the
    /// update, with a button.
    AppOpen,
    /// An AI client has the connector running and this is the daily run. The
    /// installer kills the connector (gotcha #23), so the next logon installs
    /// instead, before anything is open.
    ConnectorInUse,
}

/// What is true on the machine when an update is found.
#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub app_open: bool,
    pub connector_running: bool,
    pub trigger: Trigger,
}

/// Install now, or wait for a better moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Install,
    Defer(DeferReason),
}

/// The one rule for an unattended install.
///
/// An open interface always waits: losing a person's work is never worth an
/// update. A running connector waits only on the daily run; at logon it is
/// installed over, because logon is the least disruptive moment there will
/// be, and a rule that let a client that never closes block every update
/// would leave exactly the machines this exists for behind for good. A manual
/// run installs over it too — someone asked.
pub fn decide(facts: Facts) -> Decision {
    if facts.app_open {
        Decision::Defer(DeferReason::AppOpen)
    } else if facts.connector_running && facts.trigger == Trigger::Daily {
        Decision::Defer(DeferReason::ConnectorInUse)
    } else {
        Decision::Install
    }
}

/// How long an update may wait before the connector mentions it. A day, so a
/// machine where the schedule works never sees the note: the logon or daily
/// run installs well within it.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub const NOTICE_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// The line the MCP connector adds to its instructions when an update has
/// been waiting longer than [`NOTICE_AFTER_MS`] — the last layer, for the
/// machine where every schedule was refused. It reads only what the app
/// already recorded; the connector itself never contacts the feed, so its
/// network footprint stays the databases it was pointed at.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn pending_notice(record: &record::UpdaterRecord, current: &str, now: i64) -> Option<String> {
    let available = record.available.as_ref()?;
    if !is_newer(&available.version, current) || now - available.first_seen_ms < NOTICE_AFTER_MS {
        return None;
    }
    Some(format!(
        "Note for the assistant: HuginnDB {new} has been available for more than a day but is \
         not installed on this computer (this connector is {current}), so anything added since \
         is missing. Mention it to the user once, briefly: opening HuginnDB offers the update \
         under Settings → About.",
        new = available.version,
    ))
}

/// `candidate` is a later release than `current`, comparing the numeric
/// `major.minor.patch` and ignoring any pre-release suffix. Anything that
/// does not parse is not newer: a wrong "update available" is worse than a
/// missed one here.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn triple(v: &str) -> Option<(u64, u64, u64)> {
        let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
        let t = (parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(t)
    }
    matches!((triple(candidate), triple(current)), (Some(a), Some(b)) if a > b)
}

/// Milliseconds since the Unix epoch, for the records.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Bring the schedule in line with the preference from inside the running
/// app: at startup (`force = false`, only fills in what is missing) and when
/// the preference changes (`force = true`). Blocking — it shells out to
/// `schtasks` — so callers run it off the async runtime.
///
/// A debug build never touches the schedule: its executable is a dev build
/// under `target/`, and registering that at logon would outlive the checkout.
pub fn reconcile_for_app(product: &str, enabled: bool, force: bool) {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let outcome = schedule::reconcile(product, &exe, enabled, force);
    record::save_schedule(outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn each_flag_maps_to_its_request() {
        assert_eq!(
            request_from(&args(&["--update=logon"])),
            Some(Request::Update(Trigger::Logon))
        );
        assert_eq!(
            request_from(&args(&["--update=daily"])),
            Some(Request::Update(Trigger::Daily))
        );
        assert_eq!(
            request_from(&args(&["--update"])),
            Some(Request::Update(Trigger::Manual))
        );
        assert_eq!(
            request_from(&args(&["--ensure-schedule"])),
            Some(Request::EnsureSchedule)
        );
        assert_eq!(
            request_from(&args(&["--remove-schedule"])),
            Some(Request::RemoveSchedule)
        );
    }

    #[test]
    fn an_interface_launch_is_not_a_request() {
        assert_eq!(request_from(&args(&[])), None);
        assert_eq!(
            request_from(&args(&["--driver", "sqlite", "--path", "x.db"])),
            None
        );
    }

    #[test]
    fn an_unknown_trigger_still_updates_rather_than_opening_a_window() {
        assert_eq!(
            request_from(&args(&["--update=weekly"])),
            Some(Request::Update(Trigger::Manual))
        );
    }

    #[test]
    fn every_trigger_round_trips_through_its_argument() {
        for trigger in [Trigger::Logon, Trigger::Daily, Trigger::Manual] {
            assert_eq!(
                request_from(&args(&[trigger.arg()])),
                Some(Request::Update(trigger))
            );
        }
    }

    fn facts(app_open: bool, connector_running: bool, trigger: Trigger) -> Facts {
        Facts {
            app_open,
            connector_running,
            trigger,
        }
    }

    #[test]
    fn an_open_interface_always_waits() {
        for trigger in [Trigger::Logon, Trigger::Daily, Trigger::Manual] {
            assert_eq!(
                decide(facts(true, false, trigger)),
                Decision::Defer(DeferReason::AppOpen)
            );
        }
    }

    #[test]
    fn a_running_connector_only_holds_back_the_daily_run() {
        assert_eq!(
            decide(facts(false, true, Trigger::Daily)),
            Decision::Defer(DeferReason::ConnectorInUse)
        );
        assert_eq!(
            decide(facts(false, true, Trigger::Logon)),
            Decision::Install
        );
        assert_eq!(
            decide(facts(false, true, Trigger::Manual)),
            Decision::Install
        );
    }

    #[test]
    fn newer_compares_numbers_not_text() {
        assert!(is_newer("1.30.0", "1.29.0"));
        assert!(is_newer("1.10.0", "1.9.9"));
        assert!(is_newer("v2.0.0", "1.99.99"));
        assert!(!is_newer("1.29.0", "1.29.0"));
        assert!(!is_newer("1.28.5", "1.29.0"));
        assert!(!is_newer("1.30.0-canary.3", "1.30.0"));
        assert!(!is_newer("garbage", "1.29.0"));
        assert!(!is_newer("1.30", "1.29.0"));
    }

    fn waiting(version: &str, since: i64) -> record::UpdaterRecord {
        record::UpdaterRecord {
            available: Some(record::Available {
                version: version.into(),
                first_seen_ms: since,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn the_connector_speaks_up_only_after_a_day() {
        let day = NOTICE_AFTER_MS;
        assert!(pending_notice(&waiting("1.30.0", 0), "1.29.0", day - 1).is_none());
        let note = pending_notice(&waiting("1.30.0", 0), "1.29.0", day).unwrap();
        assert!(note.contains("HuginnDB 1.30.0") && note.contains("1.29.0"));
    }

    #[test]
    fn nothing_to_say_once_installed_or_with_nothing_recorded() {
        let day = NOTICE_AFTER_MS;
        assert!(pending_notice(&waiting("1.30.0", 0), "1.30.0", 10 * day).is_none());
        assert!(pending_notice(&record::UpdaterRecord::default(), "1.29.0", 10 * day).is_none());
    }

    #[test]
    fn a_quiet_machine_installs() {
        assert_eq!(
            decide(facts(false, false, Trigger::Daily)),
            Decision::Install
        );
    }
}
