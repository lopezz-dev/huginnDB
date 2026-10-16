//! Fetching `mongosh` on demand, for a machine that has none.
//!
//! HuginnDB does not bundle `mongosh` (see [`super::mongosh`]), so a user who
//! opens the Terminal on a MongoDB connection with nothing installed used to be
//! sent to MongoDB's download page and back. This module is the middle path:
//! one click downloads the official build for the platform into the app's own
//! data directory, where [`super::mongosh::locate`] finds it as one more
//! location.
//!
//! Everything about *what* is fetched is decided here, never by the frontend
//! (the same rule the theme registry follows, ADR #88): the frontend can ask
//! for "install" or "cancel" and nothing else, so it cannot name a URL.
//!
//! The source is MongoDB's own download-centre feed, [`FEED_URL`] — the file
//! `https://www.mongodb.com/try/download/shell` itself is built from. For each
//! version it lists every archive with the `sha256` MongoDB published for it,
//! which is what the download is verified against before a single byte of it is
//! unpacked. Two things that check does *not* do, so nobody mistakes it for
//! more: the digest comes from the same host as the archive, so it proves the
//! download is the file MongoDB published and not that MongoDB's own host was
//! not compromised; and the executable inside is not Authenticode-signed on
//! Windows (measured on 2.13.0 — `Get-AuthenticodeSignature` says `NotSigned`),
//! so there is no second, independent signature to verify.
//!
//! Layout on disk, under [`root`]:
//!
//! ```text
//! mongosh/
//!   2.13.0/bin/mongosh[.exe]      one directory per installed version
//!   .staging/                     where a download is built; never read by `locate`
//! ```
//!
//! A version directory appears only by renaming a fully unpacked staging
//! directory into place, so [`installed`] never sees a half-written install, and
//! an interrupted or cancelled download leaves nothing but a staging directory
//! that the next attempt removes.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::app_identity::APP_DIR;
use crate::error::{AppError, AppResult};
use crate::themes::registry::ensure_same_origin;

/// MongoDB's download-centre feed for `mongosh`.
pub const FEED_URL: &str = "https://downloads.mongodb.com/compass/mongosh.json";

/// The feed is ~1.5 MB (every version ever published); this leaves room for a
/// few years of growth and still refuses something that is not the feed.
const FEED_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Largest archive accepted. The biggest in 2.13.0 is the macOS zip at ~81 MB.
const ARCHIVE_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Largest total size unpacked. 2.13.0 is ~205 MB on Windows; the ceiling is
/// there to stop a decompression bomb, not to be tight.
const UNPACKED_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a server may take to answer a request with its headers. `reqwest`'s
/// own `connect_timeout` stops at the TCP handshake, so a proxy that accepts the
/// connection and then says nothing would otherwise hang the request for good.
const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a transfer may go without a single byte arriving — for the feed and
/// for the archive alike. Neither has a deadline as a whole (the archive is
/// ~60–90 MB, the feed ~1.5 MB, on a connection of unknown speed: a total
/// timeout would fail a slow but healthy link every time), but a stalled one
/// should not hang until the user notices.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How many times placing the unpacked directory is tried. On Windows,
/// Defender or the search indexer often has the freshly written
/// `mongosh.exe` open for a moment, and the rename fails with "access denied"
/// until they let go; `cargo` and `rustup` retry the same way.
const PUBLISH_ATTEMPTS: u32 = 6;
const PUBLISH_BACKOFF: Duration = Duration::from_millis(250);
/// Redirects followed per request, all of them within the request's own host.
const MAX_REDIRECTS: usize = 5;
/// Written inside a version directory, last, just before it is renamed into
/// place: its presence is what says the unpack finished.
const COMPLETE_MARKER: &str = ".complete";
/// Progress is reported at most once per this many bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

/// What the Terminal panel is told while an install runs, in order. `Downloading`
/// repeats; the rest happen once each.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallEvent {
    /// Reading the feed for the latest version.
    Checking,
    /// Bytes arriving. `total` is `None` when the server did not say.
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// The archive is complete and its digest is being compared.
    Verifying,
    Extracting,
}

/// A finished install.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    TarGz,
}

/// Which archive of the feed suits this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    distro: &'static str,
    arch: &'static str,
    kind: ArchiveKind,
}

impl Target {
    fn binary(&self) -> &'static str {
        if self.distro == "win32" {
            "mongosh.exe"
        } else {
            "mongosh"
        }
    }
}

/// The archive the feed offers for `os`/`arch` (`std::env::consts` spelling),
/// or `None` where MongoDB publishes none that this module can unpack.
///
/// Linux takes the build that bundles OpenSSL (the plain `linux-*.tgz`), not
/// the `-openssl11` / `-openssl3` ones, which link the system's and so depend
/// on which distribution it is. It needs glibc; on a musl distribution
/// (Alpine) it will not start, and the Terminal says so rather than the
/// download failing.
pub fn target_for(os: &str, arch: &str) -> Option<Target> {
    let (distro, feed_arch, kind) = match (os, arch) {
        ("windows", "x86_64") => ("win32", "x86_64", ArchiveKind::Zip),
        ("macos", "x86_64") => ("darwin", "x86_64", ArchiveKind::Zip),
        ("macos", "aarch64") => ("darwin", "arm64", ArchiveKind::Zip),
        ("linux", "x86_64") => ("linux", "x86_64", ArchiveKind::TarGz),
        ("linux", "aarch64") => ("linux", "arm64", ArchiveKind::TarGz),
        _ => return None,
    };
    Some(Target {
        distro,
        arch: feed_arch,
        kind,
    })
}

/// The target of the machine this is running on.
pub fn target() -> Option<Target> {
    target_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// Where downloaded copies live: `<local data dir>/<APP_DIR>/mongosh`.
///
/// The local data directory rather than the config directory every state file
/// uses (`state_file::path`): on Windows the latter is `%APPDATA%` (Roaming),
/// which a domain's roaming profile copies to a file server at every sign-in —
/// not a place for 200 MB of someone else's binary. `APP_DIR` is still the
/// base, so a canary build keeps its copy apart from the stable one (ADR #26).
/// Not created here; [`install_latest`] creates it.
pub fn root() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DIR).join("mongosh"))
}

/// `major.minor.patch` of a stable release, or `None` for anything else —
/// pre-releases (`2.14.0-rc.1`) are never offered.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

#[derive(Debug, Deserialize)]
struct Feed {
    versions: Vec<FeedVersion>,
}

#[derive(Debug, Deserialize)]
struct FeedVersion {
    version: String,
    #[serde(default)]
    downloads: Vec<FeedDownload>,
}

/// Every field defaults: the feed spans every release since 2021 and the older
/// entries are not uniform (905 of the 2.13.0-era feed's entries have no
/// `distro`), so one odd entry must not make the whole feed unreadable. An
/// entry missing what the selection needs simply never matches.
#[derive(Debug, Deserialize)]
struct FeedDownload {
    #[serde(default)]
    arch: String,
    #[serde(default)]
    distro: String,
    /// Present on the builds that link the system's OpenSSL; absent on the
    /// self-contained one this module wants.
    #[serde(default, rename = "sharedOpenssl")]
    shared_openssl: Option<serde_json::Value>,
    #[serde(default)]
    archive: FeedArchive,
}

#[derive(Debug, Default, Deserialize)]
struct FeedArchive {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha256: String,
}

/// What to download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    url: String,
    sha256: String,
    target: Target,
}

/// The newest stable version that has a build for `target`.
fn latest_release(feed: &Feed, target: Target) -> Option<Release> {
    feed.versions
        .iter()
        .filter_map(|v| parse_version(&v.version).map(|key| (key, v)))
        .filter_map(|(key, v)| {
            let want_kind = match target.kind {
                ArchiveKind::Zip => "zip",
                ArchiveKind::TarGz => "tgz",
            };
            let found = v.downloads.iter().find(|d| {
                d.distro == target.distro
                    && d.arch == target.arch
                    && d.shared_openssl.is_none()
                    && d.archive.kind == want_kind
            })?;
            Some((
                key,
                Release {
                    version: v.version.trim().to_string(),
                    url: found.archive.url.clone(),
                    sha256: found.archive.sha256.trim().to_ascii_lowercase(),
                    target,
                },
            ))
        })
        .max_by_key(|(key, _)| *key)
        .map(|(_, release)| release)
}

/// The HTTP client. HTTPS only, and a redirect is followed only while it stays
/// on the host the request started on: `ensure_same_origin` vets the URL the
/// feed *declares*, and this is what keeps the bytes that actually arrive from
/// being fetched from somewhere else along the way. `https_only` is switched
/// off by the tests alone, which talk to a loopback server.
fn build_client(https_only: bool) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_host = attempt
                .previous()
                .first()
                .is_some_and(|first| first.host_str() == attempt.url().host_str());
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if !same_host {
                attempt.error("a redirect to another host")
            } else {
                attempt.follow()
            }
        }))
        .user_agent(concat!("HuginnDB/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(AppError::from)
}

fn client() -> AppResult<reqwest::Client> {
    build_client(true)
}

/// GET `url` and wait for its headers — but not forever, and not past a
/// cancel. A `send()` left bare would hang on a server or proxy that accepts
/// the connection and stays silent, with Cancel doing nothing.
async fn get(
    client: &reqwest::Client,
    url: &str,
    cancel: &CancellationToken,
) -> AppResult<reqwest::Response> {
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled()),
        sent = tokio::time::timeout(HEADERS_TIMEOUT, client.get(url).send()) => sent
            .map_err(|_| AppError::Terminal(
                "MongoDB's download server did not answer; check the connection and try again"
                    .into(),
            ))??,
    };
    Ok(response.error_for_status()?)
}

/// The next chunk of a body, unless the transfer stalls or is cancelled.
async fn next_chunk<S, B>(stream: &mut S, cancel: &CancellationToken) -> AppResult<Option<B>>
where
    S: futures_util::Stream<Item = reqwest::Result<B>> + Unpin,
{
    let next = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled()),
        next = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => next,
    };
    match next {
        Err(_) => Err(AppError::Terminal(
            "the mongosh download stalled; check the connection and try again".into(),
        )),
        Ok(None) => Ok(None),
        Ok(Some(chunk)) => Ok(Some(chunk?)),
    }
}

/// The latest release for this machine, from the live feed.
async fn fetch_latest(client: &reqwest::Client, cancel: &CancellationToken) -> AppResult<Release> {
    let target = target().ok_or_else(|| {
        AppError::Terminal(format!(
            "MongoDB publishes no mongosh download for {} on {} that HuginnDB can unpack; \
             install it from https://www.mongodb.com/try/download/shell",
            std::env::consts::OS,
            std::env::consts::ARCH,
        ))
    })?;
    let response = get(client, FEED_URL, cancel).await?;
    if response
        .content_length()
        .is_some_and(|n| n > FEED_MAX_BYTES)
    {
        return Err(AppError::Terminal("the mongosh feed is too large".into()));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = next_chunk(&mut stream, cancel).await? {
        if body.len() as u64 + chunk.len() as u64 > FEED_MAX_BYTES {
            return Err(AppError::Terminal("the mongosh feed is too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    let feed: Feed = serde_json::from_slice(&body)?;
    let release = latest_release(&feed, target).ok_or_else(|| {
        AppError::Terminal("the mongosh feed lists no stable release for this platform".into())
    })?;
    // The archive URL is data from the feed, not something this code derives:
    // refuse one that points anywhere but the feed's own host.
    ensure_same_origin(FEED_URL, &release.url)?;
    if release.sha256.len() != 64 || !release.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Terminal(
            "the mongosh feed carries no valid sha256 for this download".into(),
        ));
    }
    Ok(release)
}

/// The newest stable `mongosh` version MongoDB offers this machine.
pub async fn latest_version() -> AppResult<String> {
    Ok(fetch_latest(&client()?, &CancellationToken::new())
        .await?
        .version)
}

/// The newest version installed under `root`, and its executable.
///
/// A directory counts only if it is named like a version, carries the marker
/// written when its unpack finished, *and* still holds the executable — so a
/// leftover from a failed prune, a stray folder, or an install an antivirus has
/// since quarantined a file of, is not mistaken for a working one (and is
/// reinstalled by the next download instead of staying broken for good).
pub fn installed(root: &Path) -> Option<(String, PathBuf)> {
    let binary = target().map(|t| t.binary()).unwrap_or(if cfg!(windows) {
        "mongosh.exe"
    } else {
        "mongosh"
    });
    fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let key = parse_version(&name)?;
            let exe = entry.path().join("bin").join(binary);
            let complete = entry.path().join(COMPLETE_MARKER).is_file();
            (complete && exe.is_file()).then_some((key, name, exe))
        })
        .max_by_key(|(key, _, _)| *key)
        .map(|(_, name, exe)| (name, exe))
}

/// The `mongosh` HuginnDB downloaded, if any — what `locate` falls back to.
pub fn downloaded() -> Option<PathBuf> {
    installed(&root()?).map(|(_, exe)| exe)
}

/// The version of HuginnDB's own copy, from the name of its directory.
pub fn downloaded_version() -> Option<String> {
    installed(&root()?).map(|(version, _)| version)
}

/// Whether `path` is inside HuginnDB's own download directory.
pub fn is_downloaded(path: &Path) -> bool {
    root().is_some_and(|root| path.starts_with(root))
}

/// What a cancelled step fails with, so [`install_release`] can tell it from
/// a real failure and report it as "nothing happened" rather than an error.
const CANCELLED: &str = "cancelled";

fn cancelled() -> AppError {
    AppError::Terminal(CANCELLED.into())
}

/// Download `release` into `dest`, returning the SHA-256 of what was written.
async fn download(
    client: &reqwest::Client,
    release: &Release,
    dest: &Path,
    cancel: &CancellationToken,
    sink: &(dyn Fn(InstallEvent) + Send + Sync),
) -> AppResult<String> {
    let response = get(client, &release.url, cancel).await?;
    let total = response.content_length();
    if total.is_some_and(|n| n > ARCHIVE_MAX_BYTES) {
        return Err(AppError::Terminal(
            "the mongosh download is larger than HuginnDB accepts".into(),
        ));
    }
    // Async file I/O (tokio runs it on its blocking pool): a chunk written
    // synchronously would stall the runtime's worker for as long as the disk —
    // or an antivirus scanning the new file — takes.
    let mut file = tokio::fs::File::create(dest).await?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    let event = |received| InstallEvent::Downloading {
        version: release.version.clone(),
        received,
        total,
    };
    sink(event(0));
    let mut stream = response.bytes_stream();
    while let Some(chunk) = next_chunk(&mut stream, cancel).await? {
        received += chunk.len() as u64;
        if received > ARCHIVE_MAX_BYTES {
            return Err(AppError::Terminal(
                "the mongosh download is larger than HuginnDB accepts".into(),
            ));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        if received - reported >= PROGRESS_STEP {
            reported = received;
            sink(event(received));
        }
    }
    file.flush().await?;
    sink(event(received));
    if total.is_some_and(|n| n != received) {
        return Err(AppError::Terminal(
            "the mongosh download ended early; try again".into(),
        ));
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// The entry's path with its first component dropped — both archives wrap
/// everything in one `mongosh-<version>-<platform>/` directory — or `None` for
/// the wrapper itself. Anything that could leave the destination (`..`, an
/// absolute path, a drive prefix) is refused rather than skipped: an archive
/// that contains one is not the archive MongoDB published.
fn strip_wrapper(entry: &Path) -> AppResult<Option<PathBuf>> {
    let mut out = PathBuf::new();
    let mut first = true;
    for part in entry.components() {
        match part {
            Component::Normal(p) => {
                if first {
                    first = false;
                } else {
                    out.push(p);
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(AppError::Terminal(format!(
                    "the mongosh archive holds an unsafe path: {}",
                    entry.display()
                )))
            }
        }
    }
    Ok((!out.as_os_str().is_empty()).then_some(out))
}

/// Copy one entry's bytes, counting them against the unpacked-size ceiling.
fn copy_limited(
    reader: &mut dyn Read,
    out: &mut fs::File,
    written: &mut u64,
    cancel: &CancellationToken,
) -> AppResult<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        *written += n as u64;
        if *written > UNPACKED_MAX_BYTES {
            return Err(AppError::Terminal(
                "the mongosh archive unpacks to more than HuginnDB accepts".into(),
            ));
        }
        out.write_all(&buf[..n])?;
    }
}

fn extract_zip(archive: &Path, dest: &Path, cancel: &CancellationToken) -> AppResult<()> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive)?)
        .map_err(|e| AppError::Terminal(format!("the mongosh archive is not a valid zip: {e}")))?;
    let mut written = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| AppError::Terminal(format!("the mongosh archive is damaged: {e}")))?;
        // `mangled_name` would silently rewrite a hostile path; the raw name
        // goes through `strip_wrapper`, which refuses one.
        let Some(rel) = strip_wrapper(Path::new(entry.name()))? else {
            continue;
        };
        if entry.is_symlink() {
            return Err(AppError::Terminal(format!(
                "the mongosh archive holds a symbolic link ({}), which HuginnDB does not unpack",
                rel.display()
            )));
        }
        let target = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)?;
        copy_limited(&mut entry, &mut out, &mut written, cancel)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path, cancel: &CancellationToken) -> AppResult<()> {
    let decoder = flate2::read::GzDecoder::new(fs::File::open(archive)?);
    let mut tar = tar::Archive::new(decoder);
    let mut written = 0u64;
    let entries = tar
        .entries()
        .map_err(|e| AppError::Terminal(format!("the mongosh archive is not a valid tar: {e}")))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|e| AppError::Terminal(format!("the mongosh archive is damaged: {e}")))?;
        let path = entry.path()?.into_owned();
        let Some(rel) = strip_wrapper(&path)? else {
            continue;
        };
        let kind = entry.header().entry_type();
        let target = dest.join(&rel);
        if kind.is_dir() {
            fs::create_dir_all(&target)?;
        } else if kind.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&target)?;
            copy_limited(&mut entry, &mut out, &mut written, cancel)?;
            #[cfg(unix)]
            if let Ok(mode) = entry.header().mode() {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))?;
            }
        } else if matches!(kind, tar::EntryType::Symlink | tar::EntryType::Link) {
            return Err(AppError::Terminal(format!(
                "the mongosh archive holds a link ({}), which HuginnDB does not unpack",
                rel.display()
            )));
        }
        // Anything else (extended headers, a PAX global header) carries
        // metadata the `tar` crate has already folded in.
    }
    Ok(())
}

fn extract(
    kind: ArchiveKind,
    archive: &Path,
    dest: &Path,
    cancel: &CancellationToken,
) -> AppResult<()> {
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest, cancel),
        ArchiveKind::TarGz => extract_tar_gz(archive, dest, cancel),
    }
}

/// Remove a directory if it is there; a failure is not worth failing over.
fn remove_dir_quietly(dir: &Path) {
    if dir.exists() {
        let _ = fs::remove_dir_all(dir);
    }
}

/// [`remove_dir_quietly`] for async code: deleting ~200 MB of files takes real
/// time, and doing it on a runtime worker would stall everything scheduled on it.
async fn remove_dir_off_runtime(dir: &Path) {
    let dir = dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || remove_dir_quietly(&dir)).await;
}

/// Older version directories, once a newer one is in place. Best effort: on
/// Windows a `mongosh.exe` that a terminal tab is still running cannot be
/// deleted, and that is fine — [`installed`] picks the newest, and the next
/// install sweeps what is left.
fn prune_older(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != keep && parse_version(&name).is_some() {
            remove_dir_quietly(&entry.path());
        }
    }
}

/// The install in progress, if any: one at a time across every window, since
/// two would write the same staging directory. Managed Tauri state.
#[derive(Default)]
pub struct Installer {
    running: parking_lot::Mutex<Option<CancellationToken>>,
}

/// What an install refused to start says, and what the interface looks for to
/// treat it as "already running" rather than as a failure.
pub const ALREADY_RUNNING: &str = "mongosh is already being downloaded";

/// The claim on the [`Installer`]. Released when dropped, so a command future
/// that is cancelled, or that panics, cannot leave the installer taken until
/// the app restarts.
pub struct InstallGuard<'a> {
    installer: &'a Installer,
    token: CancellationToken,
}

impl InstallGuard<'_> {
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        *self.installer.running.lock() = None;
    }
}

impl Installer {
    /// Claim the installer, or refuse while another install holds it.
    pub fn begin(&self) -> AppResult<InstallGuard<'_>> {
        let mut running = self.running.lock();
        if running.is_some() {
            return Err(AppError::Terminal(ALREADY_RUNNING.into()));
        }
        let token = CancellationToken::new();
        *running = Some(token.clone());
        Ok(InstallGuard {
            installer: self,
            token,
        })
    }

    /// Whether an install is running — in any window.
    pub fn is_running(&self) -> bool {
        self.running.lock().is_some()
    }

    /// Ask the running install, if any, to stop.
    pub fn cancel(&self) {
        if let Some(token) = self.running.lock().as_ref() {
            token.cancel();
        }
    }
}

/// Download, verify and unpack the latest stable `mongosh` under `root`.
///
/// `Ok(None)` means the user cancelled; nothing is left behind. When the latest
/// version is already installed it is returned without downloading anything.
pub async fn install_latest(
    root: &Path,
    cancel: &CancellationToken,
    sink: &(dyn Fn(InstallEvent) + Send + Sync),
) -> AppResult<Option<Installed>> {
    sink(InstallEvent::Checking);
    let client = client()?;
    let release = match fetch_latest(&client, cancel).await {
        Err(AppError::Terminal(m)) if m == CANCELLED => return Ok(None),
        other => other?,
    };
    install_release(root, &client, &release, cancel, sink).await
}

async fn install_release(
    root: &Path,
    client: &reqwest::Client,
    release: &Release,
    cancel: &CancellationToken,
    sink: &(dyn Fn(InstallEvent) + Send + Sync),
) -> AppResult<Option<Installed>> {
    let binary = release.target.binary();
    let final_dir = root.join(&release.version);
    let final_exe = final_dir.join("bin").join(binary);
    if final_exe.is_file() && final_dir.join(COMPLETE_MARKER).is_file() {
        return Ok(Some(Installed {
            version: release.version.clone(),
            path: final_exe.to_string_lossy().into_owned(),
        }));
    }

    let staging = root.join(".staging");
    remove_dir_off_runtime(&staging).await;
    tokio::fs::create_dir_all(&staging).await?;
    let result = stage_and_publish(root, &staging, client, release, cancel, sink).await;
    remove_dir_off_runtime(&staging).await;
    match result {
        Ok(()) => {
            let (root, keep) = (root.to_path_buf(), release.version.clone());
            let _ = tokio::task::spawn_blocking(move || prune_older(&root, &keep)).await;
            Ok(Some(Installed {
                version: release.version.clone(),
                path: final_exe.to_string_lossy().into_owned(),
            }))
        }
        Err(AppError::Terminal(m)) if m == CANCELLED => Ok(None),
        Err(e) => Err(e),
    }
}

async fn stage_and_publish(
    root: &Path,
    staging: &Path,
    client: &reqwest::Client,
    release: &Release,
    cancel: &CancellationToken,
    sink: &(dyn Fn(InstallEvent) + Send + Sync),
) -> AppResult<()> {
    let archive = staging.join("archive.part");
    let digest = download(client, release, &archive, cancel, sink).await?;

    sink(InstallEvent::Verifying);
    if digest != release.sha256 {
        return Err(AppError::Terminal(
            "the downloaded mongosh does not match the checksum MongoDB published; \
             it was discarded"
                .into(),
        ));
    }

    sink(InstallEvent::Extracting);
    let unpacked = staging.join("unpacked");
    tokio::fs::create_dir_all(&unpacked).await?;
    {
        let (kind, archive, unpacked, cancel) = (
            release.target.kind,
            archive.clone(),
            unpacked.clone(),
            cancel.clone(),
        );
        tokio::task::spawn_blocking(move || extract(kind, &archive, &unpacked, &cancel))
            .await
            .map_err(|e| AppError::Terminal(e.to_string()))??;
    }

    let exe = unpacked.join("bin").join(release.target.binary());
    if !exe.is_file() {
        return Err(AppError::Terminal(
            "the mongosh archive does not contain the mongosh executable".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755))?;
    }

    // The marker goes in last: from here on the directory is a whole install,
    // and `installed()` will not count one that lacks it.
    tokio::fs::write(unpacked.join(COMPLETE_MARKER), &release.sha256).await?;

    // Publish: one rename, so the version directory is complete or absent.
    let final_dir = root.join(&release.version);
    remove_dir_off_runtime(&final_dir).await;
    publish(&unpacked, &final_dir, cancel).await
}

/// Rename `from` to `to`, trying again a few times. A freshly written
/// `mongosh.exe` is often held open for a moment by Defender or the search
/// indexer, and Windows refuses to move a directory with an open file in it.
async fn publish(from: &Path, to: &Path, cancel: &CancellationToken) -> AppResult<()> {
    let mut attempt = 1;
    loop {
        match tokio::fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt >= PUBLISH_ATTEMPTS => {
                return Err(AppError::Terminal(format!(
                    "could not place mongosh in {}: {e}. An antivirus may be scanning it; \
                     try again in a moment.",
                    to.display()
                )))
            }
            Err(_) => {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(cancelled()),
                    _ = tokio::time::sleep(PUBLISH_BACKOFF * attempt) => {}
                }
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(json: serde_json::Value) -> Feed {
        serde_json::from_value(json).unwrap()
    }

    fn entry(distro: &str, arch: &str, kind: &str, shared: bool, sha: &str) -> serde_json::Value {
        let mut e = serde_json::json!({
            "arch": arch,
            "distro": distro,
            "archive": {
                "type": kind,
                "url": format!("https://downloads.mongodb.com/compass/{distro}-{arch}-{sha}.{kind}"),
                "sha256": sha,
            }
        });
        if shared {
            e["sharedOpenssl"] = serde_json::json!("openssl3");
        }
        e
    }

    #[test]
    fn versions_are_numeric_and_stable_only() {
        assert_eq!(parse_version("2.13.0"), Some((2, 13, 0)));
        assert_eq!(parse_version(" 2.9.10 "), Some((2, 9, 10)));
        assert_eq!(parse_version("2.14.0-rc.1"), None);
        assert_eq!(parse_version("2.14"), None);
        assert_eq!(parse_version("2.14.0.1"), None);
        assert_eq!(parse_version(".staging"), None);
    }

    #[test]
    fn the_target_follows_the_platform() {
        let win = target_for("windows", "x86_64").unwrap();
        assert_eq!(
            (win.distro, win.arch, win.kind),
            ("win32", "x86_64", ArchiveKind::Zip)
        );
        assert_eq!(win.binary(), "mongosh.exe");
        let mac = target_for("macos", "aarch64").unwrap();
        assert_eq!((mac.distro, mac.arch), ("darwin", "arm64"));
        let linux = target_for("linux", "aarch64").unwrap();
        assert_eq!(
            (linux.distro, linux.arch, linux.kind),
            ("linux", "arm64", ArchiveKind::TarGz)
        );
        assert_eq!(linux.binary(), "mongosh");
        assert!(target_for("windows", "aarch64").is_none());
        assert!(target_for("freebsd", "x86_64").is_none());
    }

    #[test]
    fn the_latest_stable_build_for_the_platform_is_picked() {
        // Listed out of order, with a pre-release newer than any stable one,
        // and with the system-OpenSSL Linux builds that must never be chosen.
        let f = feed(serde_json::json!({ "versions": [
            { "version": "2.9.2",  "downloads": [entry("linux", "x86_64", "tgz", false, "aa")] },
            { "version": "2.13.0", "downloads": [
                entry("linux", "x86_64", "tgz", true, "bb"),
                entry("linux", "x86_64", "tgz", false, "cc"),
                entry("win32", "x86_64", "zip", false, "dd"),
            ]},
            { "version": "2.14.0-rc.1", "downloads": [entry("linux", "x86_64", "tgz", false, "ee")] },
            { "version": "2.10.0", "downloads": [entry("linux", "x86_64", "tgz", false, "ff")] },
        ]}));
        let linux = latest_release(&f, target_for("linux", "x86_64").unwrap()).unwrap();
        assert_eq!(linux.version, "2.13.0");
        assert_eq!(linux.sha256, "cc");
        let win = latest_release(&f, target_for("windows", "x86_64").unwrap()).unwrap();
        assert_eq!(win.sha256, "dd");
        // 2.13.0 has no macOS build; the newest that does would be chosen, and
        // here none does.
        assert!(latest_release(&f, target_for("macos", "x86_64").unwrap()).is_none());
    }

    #[test]
    fn entries_the_feed_leaves_incomplete_are_skipped_not_fatal() {
        // The real feed has hundreds of older entries with no `distro`.
        let f = feed(serde_json::json!({ "versions": [
            { "version": "2.13.0", "downloads": [
                { "arch": "x86_64", "archive": { "type": "zip" } },
                { "targets": ["x"] },
                entry("win32", "x86_64", "zip", false, "dd"),
            ]},
            { "version": "2.12.0" },
        ]}));
        let win = latest_release(&f, target_for("windows", "x86_64").unwrap()).unwrap();
        assert_eq!(
            (win.version.as_str(), win.sha256.as_str()),
            ("2.13.0", "dd")
        );
    }

    #[test]
    fn a_platform_missing_from_the_newest_falls_back_to_an_older_version() {
        let f = feed(serde_json::json!({ "versions": [
            { "version": "2.13.0", "downloads": [entry("win32", "x86_64", "zip", false, "dd")] },
            { "version": "2.12.0", "downloads": [entry("darwin", "arm64", "zip", false, "ee")] },
        ]}));
        let mac = latest_release(&f, target_for("macos", "aarch64").unwrap()).unwrap();
        assert_eq!(mac.version, "2.12.0");
    }

    #[test]
    fn the_wrapper_directory_is_stripped_and_escapes_are_refused() {
        assert_eq!(
            strip_wrapper(Path::new("mongosh-2.13.0-win32-x64/bin/mongosh.exe")).unwrap(),
            Some(PathBuf::from("bin").join("mongosh.exe"))
        );
        assert_eq!(
            strip_wrapper(Path::new("mongosh-2.13.0-win32-x64/")).unwrap(),
            None
        );
        assert!(strip_wrapper(Path::new("mongosh-2.13.0/../../evil")).is_err());
        assert!(strip_wrapper(Path::new("/etc/passwd")).is_err());
        #[cfg(windows)]
        assert!(strip_wrapper(Path::new(r"C:\Windows\evil.dll")).is_err());
    }

    /// The production client minus `https_only`, since the tests talk to a
    /// loopback server.
    fn test_client() -> reqwest::Client {
        build_client(false).unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "huginndb-mongosh-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn a_zip_unpacks_without_its_wrapper_directory() {
        let dir = scratch("zip-ok");
        let archive = dir.join("a.zip");
        make_zip(
            &archive,
            &[
                ("mongosh-2.13.0-win32-x64/bin/mongosh.exe", b"exe"),
                ("mongosh-2.13.0-win32-x64/README", b"readme"),
            ],
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        extract_zip(&archive, &out, &CancellationToken::new()).unwrap();
        assert_eq!(
            fs::read(out.join("bin").join("mongosh.exe")).unwrap(),
            b"exe"
        );
        assert_eq!(fs::read(out.join("README")).unwrap(), b"readme");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_zip_that_escapes_its_destination_is_refused() {
        let dir = scratch("zip-evil");
        let archive = dir.join("a.zip");
        make_zip(&archive, &[("wrapper/../../escaped.txt", b"x")]);
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let err = extract_zip(&archive, &out, &CancellationToken::new()).unwrap_err();
        assert!(err.to_string().contains("unsafe path"), "{err}");
        assert!(!dir.join("escaped.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    fn make_tgz(path: &Path, files: &[(&str, &[u8], u32)]) {
        let enc = flate2::write::GzEncoder::new(
            fs::File::create(path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(enc);
        for (name, data, mode) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            tar.append_data(&mut header, name, *data).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn a_tgz_unpacks_without_its_wrapper_directory() {
        let dir = scratch("tgz-ok");
        let archive = dir.join("a.tgz");
        make_tgz(
            &archive,
            &[
                ("mongosh-2.13.0-linux-x64/bin/mongosh", b"elf", 0o755),
                ("mongosh-2.13.0-linux-x64/LICENSE", b"mit", 0o644),
            ],
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        extract_tar_gz(&archive, &out, &CancellationToken::new()).unwrap();
        assert_eq!(fs::read(out.join("bin").join("mongosh")).unwrap(), b"elf");
        assert_eq!(fs::read(out.join("LICENSE")).unwrap(), b"mit");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(out.join("bin").join("mongosh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "the executable bit survives");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancelled_extraction_stops() {
        let dir = scratch("cancel");
        let archive = dir.join("a.zip");
        make_zip(&archive, &[("w/bin/mongosh.exe", b"exe")]);
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = extract_zip(&archive, &out, &cancel).unwrap_err();
        assert!(
            matches!(&err, AppError::Terminal(m) if m == CANCELLED),
            "{err}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_newest_complete_install_is_the_one_found() {
        let root = scratch("installed");
        let binary = target().map(|t| t.binary()).unwrap_or("mongosh");
        for version in ["2.9.2", "2.13.0", "2.10.0"] {
            let bin = root.join(version).join("bin");
            fs::create_dir_all(&bin).unwrap();
            fs::write(bin.join(binary), b"x").unwrap();
            fs::write(root.join(version).join(COMPLETE_MARKER), b"sha").unwrap();
        }
        // Newer, but empty: a half-removed prune, not an install.
        fs::create_dir_all(root.join("2.20.0")).unwrap();
        // Newer, with the executable but never marked complete: an unpack
        // that did not finish, or one something has since tampered with.
        let unmarked = root.join("2.30.0").join("bin");
        fs::create_dir_all(&unmarked).unwrap();
        fs::write(unmarked.join(binary), b"x").unwrap();
        // Marked complete, but the executable has gone (quarantined).
        fs::create_dir_all(root.join("2.40.0").join("bin")).unwrap();
        fs::write(root.join("2.40.0").join(COMPLETE_MARKER), b"sha").unwrap();
        // Not a version at all.
        fs::create_dir_all(root.join(".staging").join("bin")).unwrap();
        let (version, exe) = installed(&root).unwrap();
        assert_eq!(version, "2.13.0");
        assert!(exe.ends_with(Path::new("bin").join(binary)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pruning_keeps_the_new_version_and_ignores_other_entries() {
        let root = scratch("prune");
        for dir in ["2.9.2", "2.13.0", "notes"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        prune_older(&root, "2.13.0");
        assert!(root.join("2.13.0").exists());
        assert!(!root.join("2.9.2").exists());
        assert!(root.join("notes").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_hex_of_a_digest_is_lowercase_and_full_width() {
        assert_eq!(hex(&[0x00, 0xab, 0x0f]), "00ab0f");
    }

    /// A one-shot HTTP server on loopback that answers every request with
    /// `body`, for exercising the transfer without the network.
    async fn serve(body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = socket.read(&mut buf).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{addr}/mongosh.zip")
    }

    fn release_at(url: String, sha256: String) -> Release {
        Release {
            version: "9.9.9".into(),
            url,
            sha256,
            target: target_for("windows", "x86_64").unwrap(),
        }
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn an_install_downloads_verifies_unpacks_and_publishes() {
        let work = scratch("e2e");
        let zip_path = work.join("src.zip");
        make_zip(&zip_path, &[("w/bin/mongosh.exe", b"exe-bytes")]);
        let bytes = fs::read(&zip_path).unwrap();
        let url = serve(bytes.clone()).await;
        let root = work.join("root");
        let events = parking_lot::Mutex::new(Vec::new());
        let sink = |e: InstallEvent| events.lock().push(e);

        let release = release_at(url, sha_of(&bytes));
        let done = install_release(
            &root,
            &test_client(),
            &release,
            &CancellationToken::new(),
            &sink,
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(done.version, "9.9.9");
        assert_eq!(
            fs::read(root.join("9.9.9").join("bin").join("mongosh.exe")).unwrap(),
            b"exe-bytes"
        );
        assert!(!root.join(".staging").exists(), "staging is cleaned up");
        let events = events.lock().clone();
        assert!(matches!(
            events.first(),
            Some(InstallEvent::Downloading { received: 0, .. })
        ));
        assert!(events.contains(&InstallEvent::Verifying));
        assert!(events.contains(&InstallEvent::Extracting));

        // A second run finds it installed and does not touch the network.
        let again = install_release(
            &root,
            &test_client(),
            &release_at("http://127.0.0.1:1/unreachable".into(), "00".into()),
            &CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(again.path, done.path);
        let _ = fs::remove_dir_all(work);
    }

    #[tokio::test]
    async fn a_checksum_mismatch_installs_nothing() {
        let work = scratch("badsum");
        let zip_path = work.join("src.zip");
        make_zip(&zip_path, &[("w/bin/mongosh.exe", b"exe")]);
        let url = serve(fs::read(&zip_path).unwrap()).await;
        let root = work.join("root");
        let err = install_release(
            &root,
            &test_client(),
            &release_at(url, "0".repeat(64)),
            &CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("checksum"), "{err}");
        assert!(!root.join("9.9.9").exists());
        assert!(!root.join(".staging").exists());
        let _ = fs::remove_dir_all(work);
    }

    #[tokio::test]
    async fn a_cancelled_install_leaves_nothing_and_is_not_an_error() {
        let work = scratch("cancel-install");
        let zip_path = work.join("src.zip");
        make_zip(&zip_path, &[("w/bin/mongosh.exe", b"exe")]);
        let bytes = fs::read(&zip_path).unwrap();
        let url = serve(bytes.clone()).await;
        let root = work.join("root");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = install_release(
            &root,
            &test_client(),
            &release_at(url, sha_of(&bytes)),
            &cancel,
            &|_| {},
        )
        .await
        .unwrap();
        assert!(out.is_none());
        assert!(!root.join("9.9.9").exists());
        assert!(!root.join(".staging").exists());
        let _ = fs::remove_dir_all(work);
    }

    /// A server that answers each path with a canned raw HTTP response, and
    /// one that accepts connections and then says nothing at all.
    async fn serve_routes(routes: Vec<(&'static str, String)>) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let response = routes
                        .iter()
                        .find(|(p, _)| *p == path)
                        .map(|(_, r)| r.clone())
                        .unwrap_or_else(|| {
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".into()
                        });
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        addr
    }

    async fn serve_silence() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        format!("http://{addr}/never")
    }

    fn redirect(to: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    #[tokio::test]
    async fn cancel_works_while_waiting_for_a_server_that_never_answers() {
        let url = serve_silence().await;
        let cancel = CancellationToken::new();
        let later = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            later.cancel();
        });
        // Bounded by the test's own clock, not by HEADERS_TIMEOUT: if `get`
        // ignored the cancel this would sit for 30 seconds.
        let result =
            tokio::time::timeout(Duration::from_secs(5), get(&test_client(), &url, &cancel))
                .await
                .expect("get did not return after the cancel");
        assert!(matches!(&result, Err(AppError::Terminal(m)) if m == CANCELLED));
    }

    #[tokio::test]
    async fn a_redirect_to_another_host_is_refused_and_one_within_the_host_followed() {
        // `localhost` and `127.0.0.1` are two hosts as far as the check goes.
        let addr = serve_routes(vec![
            ("/off", redirect("http://localhost:1/final")),
            ("/within", redirect("/final")),
            (
                "/final",
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
            ),
        ])
        .await;
        let base = format!("http://{addr}");
        let cancel = CancellationToken::new();
        let refused = get(&test_client(), &format!("{base}/off"), &cancel).await;
        assert!(refused.is_err(), "a redirect off the host was followed");
        let followed = get(&test_client(), &format!("{base}/within"), &cancel)
            .await
            .unwrap();
        assert_eq!(followed.text().await.unwrap(), "ok");
    }

    #[test]
    fn the_installer_is_released_when_its_claim_is_dropped() {
        let installer = Installer::default();
        let first = installer.begin().unwrap();
        assert!(installer.is_running());
        let second = installer.begin();
        assert!(matches!(second, Err(AppError::Terminal(ref m)) if m == ALREADY_RUNNING));
        installer.cancel();
        assert!(first.token().is_cancelled());
        drop(first);
        assert!(!installer.is_running());
        // A claim whose future is abandoned releases it the same way.
        let _again = installer.begin().unwrap();
    }

    #[tokio::test]
    async fn an_install_that_lost_its_marker_is_redone() {
        let work = scratch("remark");
        let zip_path = work.join("src.zip");
        make_zip(&zip_path, &[("w/bin/mongosh.exe", b"fresh")]);
        let bytes = fs::read(&zip_path).unwrap();
        let url = serve(bytes.clone()).await;
        let root = work.join("root");
        // What an earlier, damaged install left: the executable and no marker.
        let old = root.join("9.9.9").join("bin");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("mongosh.exe"), b"stale").unwrap();

        let done = install_release(
            &root,
            &test_client(),
            &release_at(url, sha_of(&bytes)),
            &CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(fs::read(&done.path).unwrap(), b"fresh");
        assert!(root.join("9.9.9").join(COMPLETE_MARKER).is_file());
        let _ = fs::remove_dir_all(work);
    }

    /// The real feed and the real archive for this machine, end to end:
    /// downloads ~60–95 MB, so `#[ignore]`d. Run it by hand when touching this
    /// module:
    ///
    /// ```text
    /// cargo test --lib live_download -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "downloads the real mongosh (~60-95 MB); run by hand"]
    async fn live_download_installs_a_working_mongosh() {
        let root = scratch("live").join("mongosh");
        let done = install_latest(&root, &CancellationToken::new(), &|e| {
            if !matches!(e, InstallEvent::Downloading { .. }) {
                println!("{e:?}");
            }
        })
        .await
        .unwrap()
        .expect("not cancelled");
        println!("installed {} at {}", done.version, done.path);
        let version = super::super::mongosh::version(Path::new(&done.path)).await;
        assert_eq!(version.as_deref(), Some(done.version.as_str()));
        let (found, _) = installed(&root).unwrap();
        assert_eq!(found, done.version);
    }
}
