//! In-app issue reporter.
//!
//! Lets the user file a **bug report** or a **feature request** straight to
//! the project's GitHub tracker without leaving the app, or — if they don't
//! have a GitHub account — hand the report to their own mail client instead.
//! Three delivery paths:
//!
//! * **Authenticated (preferred):** when the user has stored a GitHub
//!   Personal Access Token, the issue is created directly through the REST
//!   API and the created issue's URL is returned. This is the reliable path —
//!   the report definitely lands in the tracker.
//! * **Unauthenticated fallback:** with no token, we build a pre-filled
//!   `…/issues/new?title=…&body=…&labels=…` URL for the frontend to open in
//!   the browser, so the user can submit it manually. No network dependency
//!   on this path.
//! * **No GitHub account:** a `mailto:` URL prefilled with subject and body,
//!   opened in the user's default mail app. Nothing is sent by HuginnDB
//!   itself — the OS mail client does the actual delivery, so there's no
//!   secret to embed in a distributed binary.
//!
//! The PAT is stored in the OS keychain (never on disk), reusing the same
//! [`crate::keychain`] service as connection passwords.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

/// Keychain account under which the GitHub PAT is stored. Namespaced so it
/// can't collide with a connection-password account (`<id>::<user>`).
pub(crate) const GITHUB_PAT_ACCOUNT: &str = "github::pat";

/// Owner/repo the reporter files against.
const REPO: &str = "lopezz-dev/huginnDB";

/// Mailbox the `mailto:` fallback targets when the user has no GitHub
/// account. Kept separate from the maintainer's personal address on purpose.
const SUPPORT_EMAIL: &str = "contact@shion.es";

/// Diagnostics the frontend folds into a report body so we don't have to
/// gather host/runtime facts in TypeScript.
#[derive(Debug, Serialize)]
pub struct Diagnostics {
    /// App version baked in at build time (`Cargo.toml` `version`).
    pub app_version: String,
    /// Target OS (`windows` / `linux` / `macos`).
    pub os: String,
    /// Target architecture (`x86_64` / `aarch64` / …).
    pub arch: String,
}

/// One issue the user wants to file. `kind` is `"bug"` or `"feature"`; any
/// other value is treated as a bug (conservative default).
#[derive(Debug, Deserialize)]
pub struct IssueReport {
    pub kind: String,
    pub title: String,
    /// Pre-rendered markdown body (description + optional diagnostics block).
    pub body: String,
}

/// Result of [`submit_issue`]. `created` distinguishes "filed via API" from
/// "here's a pre-filled URL to open" so the frontend can word the toast right.
#[derive(Debug, Serialize)]
pub struct IssueOutcome {
    pub url: String,
    pub created: bool,
}

/// GitHub label(s) for an issue kind. Feature requests map to the
/// conventional `enhancement` label; everything else is a `bug`.
fn labels_for(kind: &str) -> Vec<&'static str> {
    match kind {
        "feature" => vec!["enhancement"],
        _ => vec!["bug"],
    }
}

/// Build-time / runtime facts for inclusion in a report body.
#[tauri::command]
pub fn get_diagnostics() -> AppResult<Diagnostics> {
    Ok(Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// Store (or, when `token` is empty, clear) the GitHub PAT in the OS keychain.
#[tauri::command]
pub fn set_github_pat(token: String) -> AppResult<()> {
    if token.trim().is_empty() {
        crate::keychain::delete_password(GITHUB_PAT_ACCOUNT)
    } else {
        crate::keychain::set_password(GITHUB_PAT_ACCOUNT, token.trim())
    }
}

/// Whether a GitHub PAT is currently stored.
#[tauri::command]
pub fn has_github_pat() -> AppResult<bool> {
    Ok(crate::keychain::get_password(GITHUB_PAT_ACCOUNT)?.is_some())
}

/// Forget the stored GitHub PAT.
#[tauri::command]
pub fn clear_github_pat() -> AppResult<()> {
    crate::keychain::delete_password(GITHUB_PAT_ACCOUNT)
}

/// File `report` as a GitHub issue.
///
/// Uses the REST API when a PAT is stored (returns the created issue URL),
/// otherwise returns a pre-filled `issues/new` URL for the frontend to open.
#[tauri::command]
pub async fn submit_issue(report: IssueReport) -> AppResult<IssueOutcome> {
    let title = report.title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput("issue title is required".into()));
    }
    let labels = labels_for(&report.kind);

    match crate::keychain::get_password(GITHUB_PAT_ACCOUNT)? {
        Some(pat) => {
            let url = create_issue_via_api(&pat, title, &report.body, &labels).await?;
            Ok(IssueOutcome { url, created: true })
        }
        None => {
            let url = prefilled_issue_url(title, &report.body, &labels)?;
            Ok(IssueOutcome {
                url,
                created: false,
            })
        }
    }
}

/// POST to the GitHub issues API and return the created issue's `html_url`.
async fn create_issue_via_api(
    pat: &str,
    title: &str,
    body: &str,
    labels: &[&str],
) -> AppResult<String> {
    let api = format!("https://api.github.com/repos/{REPO}/issues");
    let resp = reqwest::Client::new()
        .post(&api)
        // GitHub rejects requests without a User-Agent.
        .header("User-Agent", "HuginnDB")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(pat)
        .json(&serde_json::json!({
            "title": title,
            "body": body,
            "labels": labels,
        }))
        .send()
        .await?;

    let status = resp.status();
    let payload: serde_json::Value = resp.json().await?;
    if !status.is_success() {
        let message = payload
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(AppError::Transfer(format!(
            "GitHub API returned {status}: {message}"
        )));
    }
    payload
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Transfer("GitHub response had no issue URL".into()))
}

/// Build a `…/issues/new?title=…&body=…&labels=…` URL (proper percent-encoding
/// via the `url` crate) for the no-token fallback.
fn prefilled_issue_url(title: &str, body: &str, labels: &[&str]) -> AppResult<String> {
    let base = format!("https://github.com/{REPO}/issues/new");
    let mut url = url::Url::parse(&base)
        .map_err(|e| AppError::InvalidInput(format!("bad issue URL: {e}")))?;
    url.query_pairs_mut()
        .append_pair("title", title)
        .append_pair("body", body)
        .append_pair("labels", &labels.join(","));
    Ok(url.into())
}

/// Build a `mailto:` URL for the "no GitHub account" fallback: same title and
/// body as the GitHub path, but opened in the OS mail client instead. Hand-rolled
/// percent-encoding (RFC 3986 unreserved set) rather than `url`'s
/// `query_pairs_mut`, which is `application/x-www-form-urlencoded` and would
/// encode spaces as `+` — technically wrong in a `mailto:` query and rendered
/// literally by some mail clients instead of being turned back into spaces.
#[tauri::command]
pub fn mailto_report_url(report: IssueReport) -> AppResult<String> {
    let title = report.title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput("issue title is required".into()));
    }
    let prefix = match report.kind.as_str() {
        "feature" => "[Feature]",
        _ => "[Bug]",
    };
    let subject = format!("{prefix} {title}");
    Ok(format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        percent_encode_component(&subject),
        percent_encode_component(&report.body)
    ))
}

/// Percent-encode every byte outside the RFC 3986 "unreserved" set
/// (`ALPHA / DIGIT / "-" / "." / "_" / "~"`), matching JS `encodeURIComponent`
/// rather than form encoding.
fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
