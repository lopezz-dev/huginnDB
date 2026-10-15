//! Reading a VS Code extension package (`.vsix`) for the colour themes it
//! contributes.
//!
//! A `.vsix` is a ZIP with the extension rooted at `extension/`. This module
//! opens one, reads its manifest, and produces the **raw text** of the theme
//! files — nothing else. In particular it does not parse a theme, does not
//! look at a colour, and has no opinion about light versus dark: all of that
//! lives in `src/lib/vscodeTheme/`, where it is pure and testable without a
//! running app.
//!
//! The split is not arbitrary. Theme files are JSONC (JSON with comments),
//! which the frontend already parses with `jsonc-parser` and Rust would need
//! a second dependency to touch. Since the manifest itself is strict JSON,
//! the backend can do the one job it is actually needed for — unzipping —
//! and stay out of the rest.
//!
//! **`include` is handled by shipping more than was asked for.** A theme may
//! extend another file, and resolving that chain means parsing JSONC. Rather
//! than pull a JSONC parser into Rust to discover which files to read, every
//! `.json` under `extension/` comes along (within the limits below) and the
//! frontend resolves the chain against what it was given.
//!
//! [`read_archive`] is generic over its reader because the two callers hold
//! different things: importing from disk has a `File`, while installing from
//! the registry has the downloaded bytes in memory and must never write them
//! out just to read them back.

use std::collections::BTreeMap;
use std::io::{Read, Seek};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Largest single entry read out of the archive. A theme file runs 18–62 KB
/// across the themes this was tested on; 2 MiB is far above any real one and
/// far below what would matter if an archive lied about its contents.
pub const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
/// Ceiling on everything extracted from one archive.
pub const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// Ceiling on how many JSON entries are worth carrying back.
pub const MAX_ENTRIES: usize = 64;

/// One `contributes.themes[]` entry, as written in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    pub label: String,
    pub ui_theme: String,
    /// Kept verbatim, including any `./` prefix — the frontend canonicalises
    /// it, and it is also the key the frontend looks up in `files`.
    pub path: String,
}

/// What the importer gets back: enough to name the extension, plus the text
/// of every theme file it might need.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VsixPayload {
    pub display_name: String,
    /// `publisher.name`, for attribution in the import dialog. Empty when the
    /// manifest omits a publisher.
    pub identifier: String,
    pub version: String,
    pub license: Option<String>,
    pub themes: Vec<ThemeContribution>,
    /// Theme file bodies keyed by their path relative to `extension/`.
    pub files: BTreeMap<String, String>,
}

fn manifest_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Read one entry as UTF-8, refusing anything over [`MAX_ENTRY_BYTES`].
/// A BOM is stripped: `package.json` files written on Windows carry one often
/// enough that `serde_json` would otherwise fail on a perfectly good manifest.
fn read_entry<R: Read>(file: &mut zip::read::ZipFile<'_, R>) -> AppResult<String> {
    if file.size() > MAX_ENTRY_BYTES {
        return Err(AppError::InvalidInput(format!(
            "entry `{}` is {} bytes, over the {MAX_ENTRY_BYTES} byte limit",
            file.name(),
            file.size()
        )));
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    Ok(buf.strip_prefix('\u{feff}').unwrap_or(&buf).to_string())
}

/// Pull the colour themes a manifest contributes. Entries without a usable
/// `path` are dropped rather than failing the read — an extension may
/// contribute an icon theme alongside colour ones, and the `Themes` category
/// covers both, so this is also what tells them apart.
pub fn contributed_themes(manifest: &serde_json::Value) -> Vec<ThemeContribution> {
    manifest
        .get("contributes")
        .and_then(|c| c.get("themes"))
        .and_then(|t| t.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path")?.as_str()?.trim().to_string();
                    if path.is_empty() {
                        return None;
                    }
                    Some(ThemeContribution {
                        label: manifest_string(entry.get("label")),
                        ui_theme: manifest_string(entry.get("uiTheme")),
                        path,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read a `.vsix` from anything seekable and return the colour themes it
/// contributes.
///
/// Fails when the input is not a ZIP, has no `extension/package.json`, or
/// contributes no themes — the three cases where continuing would only defer
/// the same message to a less useful place.
pub fn read_archive<R: Read + Seek>(reader: R) -> AppResult<VsixPayload> {
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::InvalidInput(format!("not a readable .vsix archive: {e}")))?;

    let manifest: serde_json::Value = {
        let mut entry = archive
            .by_name("extension/package.json")
            .map_err(|_| AppError::NotFound("extension/package.json not found in .vsix".into()))?;
        serde_json::from_str(&read_entry(&mut entry)?)?
    };

    let themes = contributed_themes(&manifest);
    if themes.is_empty() {
        return Err(AppError::InvalidInput(
            "this extension contributes no colour themes".into(),
        ));
    }

    // Every `.json` under `extension/`, so an `include` chain resolves on the
    // frontend without the backend having to parse JSONC to find out which
    // files matter. `package.json` is excluded: it is the manifest, already
    // read, and never a theme.
    let mut files = BTreeMap::new();
    let mut total: u64 = 0;
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    for name in names {
        let Some(relative) = name.strip_prefix("extension/") else {
            continue;
        };
        if relative == "package.json" || !relative.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if files.len() >= MAX_ENTRIES || total >= MAX_TOTAL_BYTES {
            break;
        }
        let Ok(mut entry) = archive.by_name(&name) else {
            continue;
        };
        if entry.size() > MAX_ENTRY_BYTES || total + entry.size() > MAX_TOTAL_BYTES {
            continue;
        }
        // A single unreadable entry (bad UTF-8, a directory that looks like a
        // file) must not fail the whole import — the theme the user picked
        // may well not be that one.
        if let Ok(text) = read_entry(&mut entry) {
            total += text.len() as u64;
            files.insert(relative.to_string(), text);
        }
    }

    let display_name = {
        let display = manifest_string(manifest.get("displayName"));
        if display.is_empty() {
            manifest_string(manifest.get("name"))
        } else {
            display
        }
    };
    let publisher = manifest_string(manifest.get("publisher"));
    let name = manifest_string(manifest.get("name"));

    Ok(VsixPayload {
        display_name,
        identifier: if publisher.is_empty() {
            name
        } else {
            format!("{publisher}.{name}")
        },
        version: manifest_string(manifest.get("version")),
        license: manifest
            .get("license")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        themes,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::path::{Path, PathBuf};
    use zip::write::SimpleFileOptions;

    /// A throwaway file under the OS temp dir that deletes itself on drop.
    /// Deliberately not `tempfile`: the crate is not a dependency here, and
    /// every other test in this workspace already builds scratch paths this
    /// way (see `state_file.rs`, `db/exec.rs`). Never anywhere near the real
    /// state directory — see convention #52.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    fn scratch(bytes: &[u8]) -> Scratch {
        let path =
            std::env::temp_dir().join(format!("huginndb-vsix-{}.vsix", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        Scratch(path)
    }

    fn zip_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn read(entries: &[(&str, &str)]) -> AppResult<VsixPayload> {
        read_archive(Cursor::new(zip_bytes(entries)))
    }

    const MANIFEST: &str = r#"{
        "name": "my-theme",
        "displayName": "My Theme",
        "publisher": "someone",
        "version": "1.2.3",
        "license": "MIT",
        "contributes": { "themes": [
            { "label": "My Theme Dark", "uiTheme": "vs-dark", "path": "./themes/dark.json" },
            { "label": "My Theme Light", "uiTheme": "vs", "path": "./themes/light.json" }
        ] }
    }"#;

    #[test]
    fn reads_manifest_and_theme_files() {
        let payload = read(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", r#"{"colors":{}}"#),
            ("extension/themes/light.json", r#"{"colors":{}}"#),
        ])
        .unwrap();

        assert_eq!(payload.display_name, "My Theme");
        assert_eq!(payload.identifier, "someone.my-theme");
        assert_eq!(payload.version, "1.2.3");
        assert_eq!(payload.license.as_deref(), Some("MIT"));
        assert_eq!(payload.themes.len(), 2);
        assert_eq!(payload.themes[0].path, "./themes/dark.json");
        // Keyed relative to `extension/`, matching what the frontend
        // canonicalises a contributed path down to.
        assert!(payload.files.contains_key("themes/dark.json"));
        assert!(payload.files.contains_key("themes/light.json"));
    }

    #[test]
    fn reads_the_same_archive_from_a_file_and_from_memory() {
        // The two install paths must agree: importing from disk holds a
        // `File`, installing from the registry holds bytes it must not have
        // to write out first.
        let entries = [
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", r#"{"colors":{}}"#),
            ("extension/themes/light.json", r#"{"colors":{}}"#),
        ];
        let bytes = zip_bytes(&entries);
        let f = scratch(&bytes);
        let from_disk = read_archive(std::fs::File::open(f.path()).unwrap()).unwrap();
        let from_memory = read_archive(Cursor::new(bytes)).unwrap();
        assert_eq!(from_disk.identifier, from_memory.identifier);
        assert_eq!(from_disk.files, from_memory.files);
    }

    #[test]
    fn carries_json_files_the_manifest_never_named() {
        // The `include` case: `base.json` is not contributed, but a
        // contributed theme may extend it, so it must come along.
        let payload = read(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", r#"{"include":"./base.json"}"#),
            ("extension/themes/light.json", "{}"),
            ("extension/themes/base.json", r#"{"colors":{}}"#),
        ])
        .unwrap();
        assert!(payload.files.contains_key("themes/base.json"));
        // The manifest itself is never handed back as a theme file.
        assert!(!payload.files.contains_key("package.json"));
    }

    #[test]
    fn ignores_non_json_and_out_of_root_entries() {
        let payload = read(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
            ("extension/icon.png", "not really a png"),
            ("elsewhere/sneaky.json", r#"{"colors":{}}"#),
            ("[Content_Types].xml", "<xml/>"),
        ])
        .unwrap();
        assert_eq!(payload.files.len(), 2);
        assert!(!payload.files.keys().any(|k| k.contains("sneaky")));
    }

    #[test]
    fn strips_a_byte_order_mark_from_the_manifest() {
        let with_bom = format!("\u{feff}{MANIFEST}");
        let payload = read(&[
            ("extension/package.json", &with_bom),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
        ])
        .unwrap();
        assert_eq!(payload.version, "1.2.3");
    }

    #[test]
    fn rejects_an_extension_contributing_no_themes() {
        let r = read(&[(
            "extension/package.json",
            r#"{"name":"x","version":"1","contributes":{"commands":[]}}"#,
        )]);
        assert!(matches!(r, Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn rejects_an_archive_without_a_manifest() {
        assert!(matches!(
            read(&[("extension/themes/dark.json", "{}")]),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn rejects_a_file_that_is_not_a_zip() {
        assert!(matches!(
            read_archive(Cursor::new(b"this is plainly not a zip archive".to_vec())),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn refuses_an_entry_over_the_size_limit() {
        // Oversized entries are skipped rather than failing the import, so a
        // bloated sibling file cannot block a perfectly good theme.
        let huge = "x".repeat((MAX_ENTRY_BYTES + 1) as usize);
        let payload = read(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
            ("extension/themes/huge.json", &huge),
        ])
        .unwrap();
        assert!(!payload.files.contains_key("themes/huge.json"));
        assert!(payload.files.contains_key("themes/dark.json"));
    }

    #[test]
    fn tells_a_colour_theme_from_an_icon_theme() {
        // What makes registry filtering cheap: the `Themes` category covers
        // both, and only `contributes.themes` separates them.
        let icon: serde_json::Value = serde_json::from_str(
            r#"{"contributes":{"iconThemes":[{"id":"x","path":"./i.json"}]}}"#,
        )
        .unwrap();
        assert!(contributed_themes(&icon).is_empty());
        let colour: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(contributed_themes(&colour).len(), 2);
    }
}
