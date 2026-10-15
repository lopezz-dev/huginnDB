//! Command surface for VS Code theme import and the Open VSX browser.
//!
//! Thin, like every module here: validate, delegate to [`crate::themes`],
//! persist. Nothing in this file looks at a colour — the palette derivation
//! and the Monaco translation are the frontend's (`src/lib/vscodeTheme/`), and
//! keeping that boundary is what makes the interesting half testable without
//! an app. See ADR #87.

use std::io::Cursor;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::themes::{registry, store, vsix};

/// Read a `.vsix` the user picked from disk.
#[tauri::command]
pub async fn read_vsix(path: String) -> AppResult<vsix::VsixPayload> {
    tauri::async_runtime::spawn_blocking(move || vsix::read_archive(std::fs::File::open(&path)?))
        .await
        .map_err(|e| AppError::InvalidInput(format!("vsix read task failed: {e}")))?
}

/// The registry the app may talk to, or an error when the user has turned the
/// browser off.
///
/// **The registry URL is read here, never passed in from the frontend.** Same
/// rule as the AI panel's endpoint (ADR #71): a caller that can name the
/// destination is a caller that can bypass the kill-switch, and a preference
/// that only the UI honours is not a preference, it is a suggestion. The
/// frontend's job is to ask for a search; where that search goes is settled on
/// this side.
fn registry_base() -> AppResult<String> {
    let prefs = crate::prefs::load_preferences();
    if !prefs.themes.registry_enabled {
        return Err(AppError::InvalidInput(
            "the theme registry is turned off in Settings".into(),
        ));
    }
    registry::normalize_base(&prefs.themes.registry_url)
}

/// Search the configured registry for colour themes.
#[tauri::command]
pub async fn search_registry_themes(
    query: String,
    offset: u64,
    size: u64,
) -> AppResult<registry::SearchPage> {
    // Clamped rather than trusted: `size` reaches a third party, and each
    // result costs a manifest fetch on top of the search itself.
    let size = size.clamp(1, 50);
    registry::search(&registry_base()?, &query, offset, size).await
}

/// Download one extension and read the themes it contributes, in one round
/// trip from the caller's point of view.
///
/// The bytes are verified against the registry's published digest and read
/// straight from memory — writing a temp file just to read it back would add a
/// failure mode (a full or read-only disk) to a path that does not need one.
///
/// The download URL arrives inside `theme`, having come from a search, so it
/// is checked against the configured registry's origin before anything is
/// fetched. Without that, "install this theme" would be an arbitrary
/// download of whatever host a stale or crafted result named.
#[tauri::command]
pub async fn install_registry_theme(
    theme: registry::RegistryTheme,
) -> AppResult<vsix::VsixPayload> {
    registry::ensure_same_origin(&registry_base()?, &theme.download_url)?;
    let bytes = registry::download_vsix(&theme).await?;
    tauri::async_runtime::spawn_blocking(move || vsix::read_archive(Cursor::new(bytes)))
        .await
        .map_err(|e| AppError::InvalidInput(format!("vsix read task failed: {e}")))?
}

/// The installed-theme library, as the Appearance panel lists it.
#[tauri::command]
pub async fn list_installed_themes() -> AppResult<store::InstalledThemes> {
    Ok(store::load())
}

/// Record an installed theme: its editor themes and, when it came from a
/// registry, everything an update needs.
#[tauri::command]
pub async fn save_installed_theme(theme: store::InstalledTheme) -> AppResult<()> {
    let mut library = store::load();
    store::upsert(&mut library, theme);
    store::save(&library)
}

/// Forget an installed theme. Silent when it is not there: the frontend
/// deletes the palette and calls this, and a theme imported before this file
/// existed has no record here — which is not an error, it is the older shape.
#[tauri::command]
pub async fn forget_installed_theme(family_id: String) -> AppResult<()> {
    let mut library = store::load();
    if store::remove(&mut library, &family_id) {
        store::save(&library)?;
    }
    Ok(())
}

/// Mark a theme's derived palette as user-edited, so an update stops
/// rewriting it. Idempotent, and called on the first edit of each theme
/// rather than on every keystroke.
#[tauri::command]
pub async fn mark_theme_palette_edited(family_id: String) -> AppResult<()> {
    let mut library = store::load();
    let Some(slot) = library.themes.iter_mut().find(|t| t.family_id == family_id) else {
        return Ok(());
    };
    if slot.palette_edited {
        return Ok(());
    }
    slot.palette_edited = true;
    store::save(&library)
}

/// One installed theme that has a newer version upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeUpdate {
    pub family_id: String,
    pub name: String,
    pub installed_version: String,
    pub available_version: String,
    /// True when the user has edited the derived palette, so the caller knows
    /// to offer "refresh the editor theme only" rather than silently
    /// re-deriving over their work.
    pub palette_edited: bool,
    /// Everything needed to perform the update without a second lookup.
    pub theme: registry::RegistryTheme,
}

/// Check every registry-sourced theme for a newer version.
///
/// Locally imported themes are skipped — they have no origin. A lookup that
/// fails is skipped too rather than failing the check: the registry returns
/// intermittent 503s, and "could not reach the registry" must not be reported
/// as "no updates", nor take down the whole list because one extension was
/// unreachable. The caller is told how many could not be checked.
#[tauri::command]
pub async fn check_theme_updates() -> AppResult<ThemeUpdateReport> {
    let library = store::load();
    let mut updates = Vec::new();
    let mut unchecked = 0usize;

    // The configured registry, for themes that carry no origin of their own.
    // Resolved once, and a disabled browser means there is nothing to check.
    let default_registry = registry_base().ok();

    for installed in &library.themes {
        // Where to ask, who to ask about, and what we currently have. A
        // registry install answers all three from its own record; a local
        // `.vsix` import answers the last two from its manifest and borrows
        // the first from preferences — which is the whole point of recording
        // an identifier for a file the user dragged in.
        let target = match (&installed.source, &installed.identifier, &installed.version) {
            (Some(s), _, _) => Some((
                s.registry_url.clone(),
                s.namespace.clone(),
                s.name.clone(),
                s.version.clone(),
            )),
            (None, Some(id), Some(version)) => id.split_once('.').and_then(|(ns, name)| {
                default_registry
                    .clone()
                    .map(|base| (base, ns.to_string(), name.to_string(), version.clone()))
            }),
            _ => None,
        };
        let Some((registry_url, namespace, name, current)) = target else {
            continue;
        };

        match registry::lookup(&registry_url, &namespace, &name).await {
            Ok(Some(latest)) if store::is_newer(&latest.version, &current) => {
                updates.push(ThemeUpdate {
                    family_id: installed.family_id.clone(),
                    name: installed.name.clone(),
                    installed_version: current,
                    available_version: latest.version.clone(),
                    palette_edited: installed.palette_edited,
                    theme: latest,
                });
            }
            // Not found is a perfectly ordinary answer for a locally imported
            // theme that this registry simply does not carry.
            Ok(_) => {}
            Err(_) => unchecked += 1,
        }
    }
    Ok(ThemeUpdateReport { updates, unchecked })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeUpdateReport {
    pub updates: Vec<ThemeUpdate>,
    /// How many installed themes could not be reached. Surfaced rather than
    /// swallowed so "0 updates" and "0 updates, 3 unreachable" can read
    /// differently.
    pub unchecked: usize,
}
