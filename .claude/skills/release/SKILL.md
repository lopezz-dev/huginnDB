---
name: release
description: Cut a HuginnDB version end to end — bump the version everywhere it is duplicated, promote both changelogs, write the "What's new" entry on minors, commit as the maintainer, fast-forward develop into main, push the annotated tag and verify the draft release. Use whenever Alex says "corte de versión", "subida de versión", "subir versión", "bump", "sube el tag", "sincroniza develop con main", "vamos a la 1.x.y", or types /release X.Y.Z — even if he does not name the skill and only says which version to go to.
argument-hint: "[X.Y.Z]"
---

# Cutting a HuginnDB release

A release here is **one clean commit on `develop`, a fast-forward of `main`, and an annotated tag**. The tag is what starts the `release` GitHub workflow, which builds the installers and leaves a **draft** release. Alex publishes the draft himself — never publish it.

Run it **automatically, start to finish, without asking for confirmation**. Invoking this skill *is* the instruction (Alex has said so every time: "hazlo todo sin pedir permiso"). Stop only when a check fails, and then say what failed — do not work around it with force flags.

Everything below runs in the Bash tool (Git Bash). Report to Alex in Spanish, briefly.

## Why it is shaped like this

- **No PR for the cut.** Every other change lands via a PR into `develop`; the release commit is the one explicit exception (it only moves version strings and promotes changelogs, and a PR would add a squash/merge step between "cut" and "tag"). Alex confirmed this from 1.26.0 on.
- **`develop` → `main` must be a fast-forward**, so both branches end on the very same commit and the tag points at a commit that exists on both. If `main` has diverged, something is wrong — stop.
- **The tag is annotated and written `vX.Y.Z`** (a stray `v.1.19.0` exists in history; do not repeat it). Never delete or move the `canary` tag, it is the rolling canary channel.
- **The commit author is Alex, the committer is left alone.** The remote session's SSH signing key is registered to the committer address; overriding `user.email` makes GitHub mark every commit *Unverified*. `--author` is the whole mechanism, and `--amend --reset-author` would undo it.

## 1. Preflight (stop if any fails)

```bash
cd /d/sourcecode/huginnDB
git fetch origin --tags -q
git branch --show-current                      # must be: develop
git status --porcelain                         # must be empty
git rev-parse develop origin/develop           # must match (else: git merge --ff-only origin/develop)
git tag -l "vX.Y.Z"                            # must be empty
git merge-base --is-ancestor origin/main develop && echo ok   # must print ok
```

Also check:

- The four manifests currently agree on the previous version (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/mcp-server/Cargo.toml`) and the target is greater.
- `## [Unreleased]` in `CHANGELOG.md` and `## [Sin publicar]` in `CHANGELOG.es.md` both have content, with the **same number of entries per `###` subsection**. If the Spanish file is behind, translate the missing entries now as part of the cut — the two files are one deliverable.
- Compare `git log --first-parent --oneline vPREV..develop` with the changelog. A merged `feat:`/`fix:` PR with no entry means the changelog was forgotten (it has happened: 1.21.0). Add the entry in both languages, in the style of its neighbours.

## 2. Pick the version

If Alex gave one, use it. Otherwise: anything under `### Added` (new behaviour) → **minor**; only `### Fixed`/`### Changed` polish → **patch**. State the choice in one line. Do not drop to a patch just to dodge the "Fit and finish" rhythm rule (see §8) — new functionality is a minor under SemVer.

## 3. Bump the version

Edit exactly these, nothing else:

| File | What |
|---|---|
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package].version` |
| `src-tauri/mcp-server/Cargo.toml` | `[package].version` |
| `src-tauri/Cargo.lock` | the `version` line of the two path packages `huginndb` and `huginndb-mcp` only |

For `Cargo.lock` never do a blind find-and-replace of the old version string — other crates may share it. Target the two `[[package]]` blocks by name. `cargo check --locked` in §5 is the proof that the lock is right.

`mcpb/manifest.json` is **deliberately untouched**: `scripts/build-mcpb.sh` overwrites its `version` from `package.json` at package time.

## 4. Changelogs and (minors only) the "What's new" entry

**Both changelogs**, same turn. Date is today (`date +%F`), separator is an em dash:

- `CHANGELOG.md`: insert `## [X.Y.Z] — YYYY-MM-DD` directly under an emptied `## [Unreleased]`, so `Unreleased` stays at the top, empty.
- `CHANGELOG.es.md`: same with `## [Sin publicar]`.

**Minor releases additionally:**

1. `src/lib/appInfo/releaseNotes.ts` — add a new entry **at the top** of `RELEASE_NOTES` (it is newest-first): `version: "X.Y.Z"` (exact string match with the manifest — the auto-trigger compares it literally), `major: true`, `taglineKey`, and 4–7 `highlights`, each `{ icon, titleKey, bodyKey }`. Import any new lucide icon in the existing import list (keep it alphabetical-ish, and confirm the icon exists in the bundled lucide version).
2. `src/lib/i18n/locales/en.json` **and** `es.json` — add `whatsNew.releases.X_Y_Z` (dots become underscores) at the top of `releases`: a `tagline` and `items.<camelCaseName>.{title,body}` for every highlight.
3. `CLAUDE.md` — change the status in the Identity bullet, `Status: **PREV.x**` → `Status: **X.Y.x**`. If the minor introduced a structural rule worth a sentence there (as 1.25–1.29 did), add it.

Write the highlights **by hand** from the user's point of view — what changed for them, not what files moved. Fold related changelog entries into one highlight, and promote a fix only if it silently corrupted data or was very visible. Look at the previous entry for tone and length.

**Patch releases** touch neither `releaseNotes.ts` nor the i18n files nor `CLAUDE.md`.

## 5. Verify before committing

```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo check --locked && cargo check --locked -p huginndb-mcp && cargo test --lib
```

The tests include the i18n/appInfo checks that catch a missing translation key or a `releaseNotes` entry whose version does not match. If anything fails, stop and report; do not commit a broken cut.

## 6. Commit

A cut is its own commit — never fold a fix into it. Stage files by name (`git add <the files above>`), not `git add -A` or `commit -am`, so nothing stray rides along.

Subject: `chore(release): cut X.Y.Z`.

Body, in English, long-form (Alex reads it and values the why): what the cut promotes ("Everything under `Unreleased` since PREV becomes `[X.Y.Z] — date` in both changelogs…"), the places the version moved, that `mcpb/manifest.json` is untouched on purpose; for a minor, *why it is a minor* and what the headline is, and that `releaseNotes.ts` gained an entry flagged `major`; for a patch, which fixes it closes out. Mention anything out of the ordinary (e.g. a release that needs a manual step on users' machines). End with:

```
Authored by Alex López (lopezz-dev) <alexlopezdelafuente@gmail.com>.

Co-Authored-By: <the attribution line the system gives you>
```

Write the message to a file in the scratchpad with a heredoc (no BOM — PowerShell redirection adds one) and commit with:

```bash
git commit --author="Alex López <alexlopezdelafuente@gmail.com>" -F <msg-file>
git log -1 --format='author=%an <%ae> / committer=%cn <%ce>'   # author must be Alex
```

## 7. Publish

```bash
git merge-base --is-ancestor origin/main develop || { echo "main diverged"; exit 1; }
git push origin develop
git push origin develop:main            # fast-forward only; never --force
git tag -a vX.Y.Z -m "HuginnDB X.Y.Z"
git push origin vX.Y.Z
git fetch -q origin && git branch -f main origin/main
git rev-parse --short origin/main origin/develop 'vX.Y.Z^{commit}'   # all three identical
```

Pushing the tag starts the `release` workflow; pushing `main` starts `ci`.

## 8. Watch the build and check the draft

Find the runs (`gh run list --limit 5 --json name,headBranch,status,url`) and wait for `release` and `ci` with `gh run watch <id> --exit-status` in the background — do not poll in a sleep loop.

If a leg fails, read `gh run view <id> --log-failed`, report the cause, and stop. Do **not** re-tag or force-push; a fix goes in as a normal change and Alex decides what happens to the tag. (Past example: 1.21.0 failed packaging the `.mcpb` on Windows because Git Bash's `/d/...` paths mean nothing to native `node.exe`.)

When `release` is green, verify the **draft** (it has an `untagged-…` URL, so look it up by tag name):

```bash
gh api repos/lopezz-dev/huginnDB/releases --jq '.[] | select(.tag_name=="vX.Y.Z") | {draft, html_url, n: (.assets|length)}'
```

Expect `draft: true` and about 11 assets: the Windows `HuginnDB_X.Y.Z_x64-setup.exe`, the Linux `.AppImage`/`.deb`/`.rpm`, the two `huginndb-mcp-X.Y.Z-*.mcpb`, `latest.json` and a `.sig` per installer. Download `latest.json` and confirm **every entry under `platforms` has a non-empty `signature` and a URL containing `X.Y.Z`** — without signatures every installed copy rejects the update. Don't just assert it; check it.

**Never publish the draft.** Alex does that from Releases → Publish.

## 9. Report

A few sentences in Spanish: the version and whether it was minor or patch, the commit hash, that `develop`, `main` and the tag are on the same commit, the link to the draft, and what is left for Alex (publish it). If the release needs a manual step on users' machines, say so.

For a minor, add one line on *Fit and finish*: `ROADMAP.md`'s convention is that each minor closes at least two entries of that list. It is a rhythm norm, **not a gate** — never block or downgrade the release over it; just say how many closed and, if fewer than two, suggest the next minor start there.
