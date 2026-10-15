# Releasing HuginnDB

Cutting a release is a matter of bumping the version, pushing a tag, reviewing the draft release that the CI workflow produces, and clicking **Publish**. The actual installer is built by GitHub Actions, not on the maintainer's machine — a Windows `-setup.exe` (NSIS; see ADR #21 for why not MSI/WiX), plus a Linux `.deb`/`.AppImage` if that leg of the build matrix is enabled.

## One-time setup — signing keys

`tauri-plugin-updater` only installs updates whose `latest.json` carries a signature it can verify against the public key embedded in `tauri.conf.json`. You generate the keypair **once**, put the public key in the repo, and hand the private key + its password to GitHub Actions through secrets.

### 1. Generate the keypair

From the repo root, on your own machine:

```powershell
pnpm tauri signer generate -w $HOME\.tauri\huginndb.key
```

When asked, pick a password. You can leave it empty, but it's better to set one — you'll save it as a GitHub secret.

The command writes two files:

| File                              | What it is                          | Where it goes                                   |
| --------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `~/.tauri/huginndb.key`           | Encrypted **private** signing key   | GitHub secret `TAURI_SIGNING_PRIVATE_KEY`       |
| `~/.tauri/huginndb.key.pub`       | **Public** verification key         | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

> ⚠️ Store the private key + password in your password manager (1Password / Bitwarden / etc.) as well. **If you lose them, every existing installation will reject any future signed update** — you'd need to generate a new keypair and walk users through a manual reinstall.

### 2. Embed the public key

Open `~/.tauri/huginndb.key.pub` (it's a single base64 line), copy its contents, and paste them as the value of `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Replace the `REPLACE_WITH_PUBLIC_KEY_FROM_TAURI_SIGNER_GENERATE` placeholder. Commit and push — the public key is not a secret.

### 3. Add the secrets in GitHub

Go to **Settings → Secrets and variables → Actions → New repository secret** and create both:

| Secret name                              | Value                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`              | **Full content** of `~/.tauri/huginndb.key`. Easy copy on Windows: `Get-Content $HOME\.tauri\huginndb.key \| Set-Clipboard`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`     | The password from step 1. Leave empty if you didn't set one.                                            |

`GITHUB_TOKEN` is injected automatically by Actions; you don't need to add it.

### 4. Smoke test

- Confirm both secrets show up under **Settings → Secrets and variables → Actions**.
- Trigger the workflow manually once against a throwaway tag, e.g. `v0.2.1-rc1`:

  ```powershell
  git tag v0.2.1-rc1
  git push origin v0.2.1-rc1
  ```

  Then check **Actions → release**. The job should finish green and create a draft release containing the installer **and** a `latest.json` whose `signature` field is non-empty.
- Don't publish the draft if you don't want this to become the "latest" release; just delete it after the check.

## Regular release flow

Cutting a release is automated by the project skill **`/release`** (`.claude/skills/release/SKILL.md`): run `/release X.Y.Z` (or just say "corte de versión a la X.Y.Z") and it does everything below start to finish, stopping only if a check fails. This section is the human-readable version of what it does, so a cut can still be made by hand.

A cut is **one commit made directly on `develop`, a fast-forward of `main`, and an annotated tag** — no pull request. It is the one explicit exception to the "every change lands via a PR into `develop`" rule in `CLAUDE.md`: the commit only moves version strings and promotes changelogs, and the maintainer reviews the result at the draft release, not in a PR.

### 1. Preflight

On `develop`, working tree clean, `develop` equal to `origin/develop`, tag `vX.Y.Z` not yet existing, and `origin/main` an ancestor of `develop` (so the later push is a fast-forward). `## [Unreleased]` and `## [Sin publicar]` must both have content with the same entries per subsection — if a merged `feat`/`fix` has no entry, add it first.

### 2. Bump the version everywhere it is duplicated

They must stay in sync:

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package].version`
- `src-tauri/mcp-server/Cargo.toml` → `[package].version` (the MCP connector's own crate; not load-bearing for the release, but kept in sync)
- `src-tauri/Cargo.lock` → the `version` of the two path packages `huginndb` and `huginndb-mcp` only. `cargo check --locked` proves it is right.

`mcpb/manifest.json` is deliberately **not** on that list: `scripts/build-mcpb.sh` overwrites its `version` from `package.json` when it packages the bundle, so the committed value is a placeholder and cannot drift.

### 3. Changelogs, and the "What's new" entry on minors

- `CHANGELOG.md` and `CHANGELOG.es.md`, **both, in the same commit**: promote `## [Unreleased]` / `## [Sin publicar]` to a dated `## [X.Y.Z] — YYYY-MM-DD` section, leaving an empty one on top.
- **Minor releases** (anything new under `### Added`) also get: a new top entry in `src/lib/appInfo/releaseNotes.ts` (`version` exactly equal to the manifest, `major: true`, 4–7 hand-written highlights), its copy under `whatsNew.releases.X_Y_Z` in `src/lib/i18n/locales/en.json` and `es.json`, and the `Status: **X.Y.x**` line in `CLAUDE.md`.
- **Patch releases** touch none of those three.

### 4. Verify, then commit

```powershell
pnpm typecheck; pnpm test
cd src-tauri; cargo check --locked; cargo check --locked -p huginndb-mcp; cargo test --lib
```

Commit with a long-form message explaining the *why* of the cut, authored by the maintainer and with the committer left alone (overriding `user.email` makes GitHub mark the commit *Unverified*):

```bash
git add <the files above>
git commit --author="Alex López <alexlopezdelafuente@gmail.com>" -F msg.txt   # subject: chore(release): cut X.Y.Z
```

### 5. Sync `main` and push the tag

```bash
git push origin develop
git push origin develop:main        # fast-forward only, never --force
git tag -a vX.Y.Z -m "HuginnDB X.Y.Z"
git push origin vX.Y.Z
```

The tag is `vX.Y.Z` — no stray dot (`v.1.19.0` exists in history by mistake) — and `main`, `develop` and the tag must end on the same commit. Never touch the `canary` tag: it is the rolling canary channel.

### 6. Check the draft and publish

1. Wait for the **release** workflow in Actions (and `ci` on `main`). A **draft** release appears in **Releases**.
2. Sanity-check the draft: about 11 assets — the Windows `-setup.exe`, the Linux `.AppImage`/`.deb`/`.rpm`, the two `huginndb-mcp-X.Y.Z-*.mcpb`, `latest.json` and one `.sig` per installer. In `latest.json` **every `platforms` entry must carry a non-empty `signature`** and a URL for the new version; without that every installed copy rejects the update.
3. Click **Publish release**. This step is always manual. Installed copies will see the update on their next launch (or silently, on machines with the background updater) and prompt to install it.

If a build leg fails, do not re-tag or force-push: fix it as a normal change and decide what to do with the tag afterwards.

## What happens on the user's side

- At launch, the app calls `latest.json` at the URL configured in `tauri.conf.json` → `plugins.updater.endpoints`.
- If the version field is greater than the running version, a toast appears once, and a red dot lands on the settings gear.
- The user clicks **Install and relaunch** → the plugin verifies the signature with the embedded public key → downloads the signed installer → installs → relaunches.
- If the user clicks **Later**, the toast won't reappear for that version, but the gear badge persists until the install runs.
