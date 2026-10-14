# Canary channel

The **canary** channel lets you dogfood an in-progress change against your
real production connection profiles **before** promoting it to a stable
release — without cutting a full release and without any risk to the state of
your installed stable app.

A canary build is a completely separate application that installs and runs
**side-by-side** with the stable HuginnDB:

| | Stable | Canary |
| --- | --- | --- |
| Product name | HuginnDB | HuginnDB Canary |
| Bundle identifier | `io.huginndb.app` | `io.huginndb.canary` |
| On-disk state dir | `<config>/HuginnDB` | `<config>/HuginnDB-Canary` |
| Updater feed | `releases/latest/…/latest.json` | `releases/download/canary/latest.json` |
| OS keychain service | `io.huginndb.app` | `io.huginndb.app` *(shared)* |

Two deliberate design choices make this work:

- **State is isolated.** The `canary` Cargo feature switches
  `crate::app_identity::APP_DIR` to `HuginnDB-Canary`, so every state file
  (`profiles.json`, `prefs.json`, `tab_state.json`, `known_hosts.json`, the MCP
  audit log) lives in its own directory. A change that performs a destructive,
  one-way on-disk migration (e.g. the tab-state v2→v3 migration) can be
  exercised in the canary without ever touching your production state.
- **Credentials are shared.** The OS keychain service is *not* build-aware
  (see `src-tauri/src/keychain.rs`). The canary reads the passwords the stable
  build already stored, so you can test against production profiles without
  re-entering anything. The canary only ever *writes* to the keychain if you
  explicitly add, edit, or remove a profile from inside it.

> The canary starts with an empty profile list (its state dir is separate). To
> point it at your production profiles, copy `profiles.json` from the stable
> config dir into the `HuginnDB-Canary` dir — the passwords resolve from the
> shared keychain automatically, no secrets are copied. (A one-click import is
> a natural follow-up; not built yet.)

## How it fits into git

You do **not** cut a release tag for a canary. The whole point is to build from
work that isn't released yet.

1. Your change lives on a branch (feature branch or your development branch).
   `main` and the stable release tags are untouched.
2. You trigger the **canary** workflow against that branch (see below). It
   builds from the exact branch/commit you pick — no tag required.
3. When you're happy with it, you promote normally: merge the branch to `main`,
   bump the version in `src-tauri/tauri.conf.json`, and push a `vX.Y.Z` tag. The
   stable `release` workflow then publishes the real release to the stable
   updater feed. The canary was only the rehearsal.

### Worked example — testing a 1.10.1 candidate while 1.10.0 is in production

```
# work on the change
git switch -c feature/big-change
# … commits …
git push -u origin feature/big-change
```

Then in the GitHub UI: **Actions → canary → Run workflow**, and set:

- **Use workflow from**: `feature/big-change` (or leave `ref` empty and it
  builds the branch you selected here)
- **version**: `1.10.1`

The build is stamped `1.10.1-canary.<run_number>` (e.g. `1.10.1-canary.7`). The
prerelease suffix sorts *below* the eventual stable `1.10.1`, so a canary never
outranks a real release. Each run bumps `<run_number>`, so the canary updater
always sees a newer version and offers the update.

Iterate as many times as you like (each push → new canary run → new
`-canary.N`). When it's solid:

```
git switch main && git merge feature/big-change
# bump "version" to 1.10.1 in src-tauri/tauri.conf.json, commit
git tag v1.10.1 && git push origin main v1.10.1
```

## How it runs on your machine

1. **Install HuginnDB Canary once.** Download the installer from the rolling
   [`canary` release](https://github.com/lopezz-dev/huginnDB/releases/tag/canary)
   and install it. It won't disturb your stable install.
2. **After that, it auto-updates on its own channel.** Every canary build you
   publish replaces the rolling `canary` release, so the canary app detects the
   new `-canary.N` version on next launch and offers to install it — exactly
   like the stable updater, but isolated to the canary channel.
3. Point it at your production profiles (see the note above) and test away.

### Telling the sandbox apart from stable

The canary shares the React bundle and the OS keychain with the stable app, so
once you are inside the window the two would otherwise look identical. The
canary build makes its identity unmistakable:

- A persistent amber **SANDBOX · HuginnDB Canary** ribbon pinned above the
  header (it also names the isolated `HuginnDB-Canary` state dir).
- A **CANARY** badge next to the brand in the header breadcrumb.
- A flavor-aware OS window title (**HuginnDB Canary** in the taskbar and
  Alt-Tab switcher), so it is tellable apart from outside the window too.
- The **About** panel shows the canary product name and the real
  `HuginnDB-Canary` prefs paths.

None of this appears in the stable build. The frontend learns which flavor it
is running via the `get_app_flavor` command (`commands::app`), which reports
the compile-time `canary` Cargo feature — the JS bundle itself is identical
across flavors, so a runtime query is the only signal available.

## Building locally

You can also build a canary bundle without CI:

```powershell
pnpm tauri build --config src-tauri/tauri.canary.conf.json --features canary
```

Or just run a canary-flavoured dev shell (isolated state dir, no separate
updater):

```powershell
pnpm tauri dev --features canary
```

## Notes / limitations

- The workflow builds **Windows** only (matching the stable release matrix).
  Add platforms to `.github/workflows/canary.yml`'s matrix if you need them.
- Canary artifacts are signed with the **same** updater keypair as stable
  (`TAURI_SIGNING_PRIVATE_KEY`), so they verify with the public key already in
  `tauri.conf.json` (inherited by the canary config).
- The bundled `huginndb-mcp` sidecar is built *stable* (not with the `canary`
  feature), so if you use the MCP connector from a canary install its audit log
  goes to the stable `HuginnDB` dir. This is cosmetic — the audit log isn't
  state that migrations corrupt — and avoids a feature-passthrough in the
  sibling `mcp-server` crate. Split it if that ever matters.
