//! `installed_themes.json` — the library of themes that came from a file or a
//! registry, and everything needed to update one.
//!
//! # Why this file exists at all
//!
//! Before it, an imported theme lived entirely in the frontend's
//! localStorage-backed theme store, which was right for a handful of
//! hand-imported ones and stops being right the moment a registry browser can
//! install a dozen. The split is by *shape*, not by size alone:
//!
//! - **The palettes stay in localStorage.** Thirty hex values per variant,
//!   read synchronously before first paint so the app does not flash the
//!   wrong theme (`STORAGE_KEYS.theme`, and see the FOUC note in
//!   `CLAUDE.md`). Moving them here would mean an async read on the critical
//!   path to fix a problem they do not have.
//! - **The editor themes and the install metadata come here.** A Monaco theme
//!   is the big part — One Dark Pro's 275 token rules serialise to ~20 KB, and
//!   a library of those is exactly what localStorage should not hold — and it
//!   is also the part that tolerates arriving late: `registerImported-
//!   MonacoThemes` defines whatever it is given whenever it is given it, so an
//!   editor that mounts first is repainted rather than broken.
//!
//! # The backend still has no opinion about colour
//!
//! `editor_themes` is stored as opaque JSON. This module does not know what an
//! `IStandaloneThemeData` is and must not learn: the conversion lives in
//! `src/lib/vscodeTheme/`, and a second interpretation here would be the
//! divergence ADRs #30/#33 exist to prevent.

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

const FILE: &str = "installed_themes.json";
const TAG: &str = "themes";

/// Where an installed theme came from, when it came from a registry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSource {
    /// Recorded per theme rather than read from preferences at update time,
    /// so pointing the app at a different registry cannot silently re-target
    /// an update at an extension that merely shares a name.
    pub registry_url: String,
    pub namespace: String,
    pub name: String,
    /// The version installed, which is what an update check compares against.
    pub version: String,
    /// Contributed paths of the variants the user picked, so an update can
    /// rebuild the same pairing without asking again.
    #[serde(default)]
    pub light_path: Option<String>,
    #[serde(default)]
    pub dark_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTheme {
    /// The custom family's id in the frontend theme store — the join key
    /// between the palette there and the editor themes here.
    pub family_id: String,
    pub name: String,
    /// Absent for a theme imported from a local file, which has no origin to
    /// check for updates and never appears in the update list.
    #[serde(default)]
    pub source: Option<ThemeSource>,
    /// The extension's own `publisher.name` from its manifest, recorded for
    /// **every** install including a local `.vsix`.
    ///
    /// It exists because [`source`] answers "where did this come from", which
    /// a file import cannot answer, while the browser also needs "which
    /// extension is this" — so that a theme installed from a downloaded
    /// `.vsix` is still recognised in the results rather than offered as if it
    /// were new. Measured against the registry before being relied on: for
    /// every colour theme sampled, `publisher.name` equals the registry's
    /// `namespace.name` exactly.
    #[serde(default)]
    pub identifier: Option<String>,
    /// The package version this install came from, recorded alongside
    /// [`identifier`] for every install.
    ///
    /// [`ThemeSource::version`] already holds this for a registry install; the
    /// duplicate exists so a **local** `.vsix` import has one too, which is
    /// what lets the update check reach it. Without a version there is nothing
    /// to compare a registry's latest against, and the theme would show as
    /// installed while silently never updating.
    #[serde(default)]
    pub version: Option<String>,
    /// RFC 3339. Informational — shown in the library, never compared.
    #[serde(default)]
    pub installed_at: String,
    /// **Set once the user edits any token of the derived palette, and never
    /// cleared by an update.** This is the flag that stops an update being a
    /// silent overwrite of someone's work: the editor themes can always be
    /// replaced (nobody hand-edits 275 token rules), but a palette the user
    /// has touched is theirs, so an update refreshes the editor half and
    /// leaves the chrome half alone unless they ask for it explicitly.
    #[serde(default)]
    pub palette_edited: bool,
    /// `{ "light": IStandaloneThemeData, "dark": ... }`, opaque to Rust.
    pub editor_themes: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledThemes {
    pub version: u32,
    #[serde(default)]
    pub themes: Vec<InstalledTheme>,
}

impl Default for InstalledThemes {
    fn default() -> Self {
        Self {
            version: 1,
            themes: Vec::new(),
        }
    }
}

/// Load the library. A missing or unparseable file yields an empty one rather
/// than an error: unlike `profiles.json` — where an empty list would show the
/// user an app that has lost every saved connection — an empty theme library
/// costs the built-in presets and nothing else, so blocking startup over it
/// would be the worse trade.
pub fn load() -> InstalledThemes {
    crate::state_file::load_or_default(FILE, TAG)
}

pub fn save(library: &InstalledThemes) -> AppResult<()> {
    crate::state_file::save_atomic(FILE, library)
}

/// Insert or replace by `family_id`, preserving the two fields that describe
/// what the *user* did rather than what the package contains.
///
/// `palette_edited` survives on purpose: re-installing or updating a theme
/// must not quietly decide that the edits someone made are gone. `installed_at`
/// survives because it means "when this theme entered the library", which an
/// update does not change.
pub fn upsert(library: &mut InstalledThemes, mut theme: InstalledTheme) {
    if let Some(existing) = library
        .themes
        .iter()
        .find(|t| t.family_id == theme.family_id)
    {
        theme.palette_edited = theme.palette_edited || existing.palette_edited;
        if theme.installed_at.is_empty() {
            theme.installed_at = existing.installed_at.clone();
        }
        // A record written before identifiers existed keeps whatever the new
        // one knows, but a new one that knows nothing must not erase it.
        if theme.identifier.is_none() {
            theme.identifier = existing.identifier.clone();
        }
        if theme.version.is_none() {
            theme.version = existing.version.clone();
        }
    }
    match library
        .themes
        .iter_mut()
        .find(|t| t.family_id == theme.family_id)
    {
        Some(slot) => *slot = theme,
        None => library.themes.push(theme),
    }
}

pub fn remove(library: &mut InstalledThemes, family_id: &str) -> bool {
    let before = library.themes.len();
    library.themes.retain(|t| t.family_id != family_id);
    before != library.themes.len()
}

/// Compare two version strings the way a user expects, digit group by digit
/// group, falling back to a plain string comparison for anything that is not
/// numeric.
///
/// Extension versions are `major.minor.patch` by convention and **not** by
/// rule, so a strict semver parse would have to decide what to do with the
/// ones that are not — and "cannot parse" must not mean "no update available",
/// which is a silent failure nobody would notice. This orders `1.10.0` after
/// `1.9.0` (which a string comparison gets wrong) without rejecting anything.
pub fn is_newer(candidate: &str, installed: &str) -> bool {
    use std::cmp::Ordering;

    /// Split `1.2.0-beta.1` into its numeric core and its pre-release tail.
    /// The two use different rules and must not share one `split`: a missing
    /// component makes a version OLDER (`1.2` < `1.2.1`) while a missing
    /// pre-release tail makes it NEWER (`1.2.0` > `1.2.0-beta`). Treating
    /// `-` as just another separator makes those two rules contradict, and
    /// the release-beats-prerelease case is the one that loses.
    fn split(v: &str) -> (&str, &str) {
        match v.find(['-', '+']) {
            Some(i) => (&v[..i], &v[i + 1..]),
            None => (v, ""),
        }
    }

    fn compare_core(a: &str, b: &str) -> Ordering {
        let parts = |v: &str| -> Vec<Result<u64, String>> {
            v.split('.')
                .map(|p| p.parse::<u64>().map_err(|_| p.to_ascii_lowercase()))
                .collect()
        };
        let (a, b) = (parts(a), parts(b));
        for i in 0..a.len().max(b.len()) {
            let ordering = match (a.get(i), b.get(i)) {
                (None, Some(_)) => Ordering::Less,
                (Some(_), None) => Ordering::Greater,
                (Some(x), Some(y)) => match (x, y) {
                    (Ok(x), Ok(y)) => x.cmp(y),
                    // A numeric component beats a textual one, so a version
                    // that is not numbers at all still orders instead of
                    // reporting "no update", which is a silent failure.
                    (Ok(_), Err(_)) => Ordering::Greater,
                    (Err(_), Ok(_)) => Ordering::Less,
                    (Err(x), Err(y)) => x.cmp(y),
                },
                (None, None) => Ordering::Equal,
            };
            if ordering != Ordering::Equal {
                return ordering;
            }
        }
        Ordering::Equal
    }

    let (core_a, pre_a) = split(candidate);
    let (core_b, pre_b) = split(installed);
    match compare_core(core_a, core_b) {
        Ordering::Greater => true,
        Ordering::Less => false,
        // Same core: having no pre-release tail is the newer of the two.
        Ordering::Equal => match (pre_a.is_empty(), pre_b.is_empty()) {
            (true, false) => true,
            (false, true) => false,
            _ => pre_a > pre_b,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find<'a>(lib: &'a InstalledThemes, id: &str) -> Option<&'a InstalledTheme> {
        lib.themes.iter().find(|t| t.family_id == id)
    }

    fn theme(id: &str, edited: bool) -> InstalledTheme {
        InstalledTheme {
            family_id: id.into(),
            name: format!("Theme {id}"),
            source: None,
            installed_at: "2026-09-17T10:00:00Z".into(),
            palette_edited: edited,
            identifier: Some("someone.my-theme".into()),
            version: Some("1.0.0".into()),
            editor_themes: serde_json::json!({ "light": {}, "dark": {} }),
        }
    }

    #[test]
    fn upsert_inserts_then_replaces() {
        let mut lib = InstalledThemes::default();
        upsert(&mut lib, theme("a", false));
        upsert(&mut lib, theme("b", false));
        assert_eq!(lib.themes.len(), 2);

        let mut renamed = theme("a", false);
        renamed.name = "Renamed".into();
        upsert(&mut lib, renamed);
        assert_eq!(lib.themes.len(), 2);
        assert_eq!(find(&lib, "a").unwrap().name, "Renamed");
    }

    #[test]
    fn upsert_never_clears_the_user_edited_flag() {
        // The whole point: an update rewrites the record, and must not decide
        // on the user's behalf that their palette edits stopped existing.
        let mut lib = InstalledThemes::default();
        upsert(&mut lib, theme("a", true));
        upsert(&mut lib, theme("a", false));
        assert!(find(&lib, "a").unwrap().palette_edited);
    }

    #[test]
    fn upsert_keeps_the_original_install_date() {
        let mut lib = InstalledThemes::default();
        upsert(&mut lib, theme("a", false));
        let mut updated = theme("a", false);
        updated.installed_at = String::new();
        upsert(&mut lib, updated);
        assert_eq!(
            find(&lib, "a").unwrap().installed_at,
            "2026-09-17T10:00:00Z"
        );
    }

    #[test]
    fn remove_reports_whether_it_removed_anything() {
        let mut lib = InstalledThemes::default();
        upsert(&mut lib, theme("a", false));
        assert!(remove(&mut lib, "a"));
        assert!(!remove(&mut lib, "a"));
    }

    #[test]
    fn version_ordering_is_numeric_per_component() {
        // The case a string comparison gets wrong, and the reason this
        // function exists rather than `<`.
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.2.3", "1.2.3"));
    }

    #[test]
    fn a_longer_version_is_newer_than_its_prefix() {
        assert!(is_newer("1.2.1", "1.2"));
        assert!(!is_newer("1.2", "1.2.1"));
    }

    #[test]
    fn a_release_is_newer_than_its_prerelease() {
        assert!(is_newer("1.2.0", "1.2.0-beta"));
        assert!(!is_newer("1.2.0-beta", "1.2.0"));
        assert!(is_newer("1.2.0-beta.2", "1.2.0-beta.1"));
    }

    #[test]
    fn a_prerelease_tail_does_not_make_a_version_look_older_than_it_is() {
        // The regression this pair exists for: `-` and `.` follow opposite
        // rules, so sharing one split made "release beats prerelease" lose to
        // "fewer components is older". A newer core wins regardless of tails.
        assert!(is_newer("1.3.0-beta", "1.2.0"));
        assert!(!is_newer("1.2.0", "1.3.0-beta"));
    }

    #[test]
    fn unparseable_versions_still_order_rather_than_reporting_no_update() {
        // "cannot parse" must never silently mean "up to date".
        assert!(is_newer("2026.02", "2025.12"));
        assert!(is_newer("v2", "v1"));
    }

    #[test]
    fn upsert_never_erases_a_known_identifier() {
        // Reinstalling from a path that does not know the identifier (an old
        // record, a future caller) must not lose the one already stored --
        // it is what matches a locally imported theme to a registry row.
        let mut lib = InstalledThemes::default();
        upsert(&mut lib, theme("a", false));
        let mut blank = theme("a", false);
        blank.identifier = None;
        upsert(&mut lib, blank);
        assert_eq!(
            find(&lib, "a").unwrap().identifier.as_deref(),
            Some("someone.my-theme")
        );
    }

    #[test]
    fn a_default_library_is_empty_and_versioned() {
        let lib = InstalledThemes::default();
        assert_eq!(lib.version, 1);
        assert!(lib.themes.is_empty());
    }

    #[test]
    fn a_record_round_trips_through_json() {
        let mut lib = InstalledThemes::default();
        let mut t = theme("a", true);
        t.source = Some(ThemeSource {
            registry_url: "https://open-vsx.org".into(),
            namespace: "dracula-theme".into(),
            name: "theme-dracula".into(),
            version: "2.25.1".into(),
            light_path: None,
            dark_path: Some("./theme/dracula.json".into()),
        });
        upsert(&mut lib, t);
        let back: InstalledThemes =
            serde_json::from_str(&serde_json::to_string(&lib).unwrap()).unwrap();
        let s = back.themes[0].source.as_ref().unwrap();
        assert_eq!(s.namespace, "dracula-theme");
        assert_eq!(s.dark_path.as_deref(), Some("./theme/dracula.json"));
        assert!(back.themes[0].palette_edited);
    }

    #[test]
    fn a_record_written_by_an_older_version_still_loads() {
        // Every added field is `#[serde(default)]`, so a file missing them
        // parses rather than dropping the whole library (gotcha #14).
        let raw = r#"{"version":1,"themes":[
            {"familyId":"a","name":"A","editorThemes":{"light":{},"dark":{}}}
        ]}"#;
        let lib: InstalledThemes = serde_json::from_str(raw).unwrap();
        assert_eq!(lib.themes.len(), 1);
        assert!(!lib.themes[0].palette_edited);
        assert!(lib.themes[0].source.is_none());
    }
}
