---
id: 87
type: adr
status: accepted
date: 2026-09-17
tags: [themes, monaco]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #87: A VS Code theme is *translated* into Monaco and *derived* into the chrome — and alpha is resolved at import, not in the pipeline

Importing a VS Code colour theme produces two things from one file, and they are not the same kind of thing. The editor half is a translation — Monaco *is* VS Code's editor, so `tokenColors` and the `editor.*` keys mean upstream exactly what they mean here. The chrome half is a derivation: ~230 keys named after widgets, read down fallback chains into 30 tokens named after roles. The import dialog says which is which before anything is committed, and the result lands in the Appearance editor so a reading the user disagrees with is a starting point rather than a bug report. Translucent `#RRGGBBAA` values are flattened at import against the theme's own `editor.background`; `applyTheme` keeps receiving the opaque hex it has always taken.

**External trap behind it:** Real VS Code themes are often JSONC (do not parse with JSON.parse), carry many translucent #RRGGBBAA colours, omit keys such as menu.* and button.*, may omit `type`, and one extension contributes several themes; Monaco's defineTheme rejects unknown colour keys.

**Decision:** Translate tokenColors/editor.* into Monaco, derive 30 chrome tokens from the theme's own fallback chains, flatten #RRGGBBAA against editor.background at import, and have the backend only unzip.

**Alternatives rejected:**

- Widening hexToRgb/applyTheme to accept alpha — rejected as the larger change, spreading alpha into every colour consumer.
- Embedding VS Code's dark_plus/light_plus defaults as fallbacks — rejected because it injects foreign colours into a theme.
- Choosing the contrast pole by a luminance threshold — rejected because it fails in mid-greys; both poles are measured.
- Deriving one variant twice under opposite isLight flags — rejected; it is derived once and copied.
- Trusting the `type` field alone to decide light/dark — rejected because it is optional (GitHub Light Default omits it).
- Parsing themes in the Rust backend — rejected because it would need a second JSONC parser.
- A regex comment stripper instead of jsonc-parser — rejected because it corrupts values containing //.
- Storing imported editor themes in prefs.json — rejected; they live in the theme store with the family's lifetime.

## Detail

**The importer was built against five real themes from open-vsx, and every design decision below came from reading them rather than from reasoning about the format.** Dracula, Tokyo Night, Nord, GitHub Light Default and One Dark Pro live in `src/lib/vscodeTheme/__fixtures__/` (all MIT, attributed in that folder's README). The measurements that drove the design: **two of the five do not parse with `JSON.parse`** (Tokyo Night carries line comments, Nord block ones), **all five carry translucent colours** (52 keys in Gruvbox, 43 in GitHub, 26 in One Dark Pro), **all five omit `menu.*`** and One Dark Pro also omits `button.foreground` and `button.hoverBackground`, and **one extension is not one theme** (GitHub contributes nine variants, Gruvbox six, One Dark Pro five). A hand-written fixture would have exhibited none of those and the importer would have shipped broken against precisely the themes people import.

**Alpha is flattened at import, and widening `hexToRgb` instead would have been the larger change.** `applyTheme` runs every token through `hexToHslTriple`, whose regex accepts `#RGB`/`#RRGGBB` and nothing else — so today a translucent value resolves to `null`, `applyTheme` calls `removeProperty`, and the token silently falls back to the `index.css` default. Fixing that at the pipeline end would mean alpha inside `light-dark()` and in every consumer of a colour token, expressing something the palette has no concept of: these colours are translucent *in VS Code* because its renderer composites them over whatever is behind them. `flattenAlpha` does that composite once, against the variant's own background, and everything downstream is unchanged. The test asserting every derived token survives `hexToHslTriple` is what pins this.

**Fallbacks stay inside the theme; VS Code's own defaults are deliberately not embedded.** Embedding `dark_plus`/`light_plus` was the plan and is worse: it injects VS Code's blue `focusBorder` into a Gruvbox import, giving a palette coherent with neither source. Instead each token walks a chain of related keys the theme *does* state, ending in a value derived from its own `editor.background`/`editor.foreground` — `mutedForeground` with no `descriptionForeground` becomes a mix of the theme's own foreground into its own background, which reads as dimmed rather than as a third hue.

**`ensureContrast` picks its pole by measuring both, not by a luminance threshold — and the intuitive version is wrong exactly where it matters.** `relativeLuminance(bg) > 0.5 ? black : white` looks right and fails in the mid-greys: WCAG relative luminance is not perceptual lightness, so `#808080` sits at **0.216** and gets sent toward white for a ratio of 3.9 when black would have given it 5.3. The break-even is near 0.179; rather than hard-code that constant both poles are tried. This was caught by a test written to assert the *opposite* — that a mid-grey cannot reach 4.5 against anything, which is false. The guard exists at all because VS Code can rescue a bad pair with a per-widget override and this palette cannot: a theme whose hover surface nearly matches its text colour would otherwise ship an unreadable selected row.

**A surface that resolves to its own background is pushed one plane away — the single place the mapping deliberately departs from the source.** Four of the five fixtures hand back at least one such surface: Nord's `sideBar.background` *is* its `editor.background`, GitHub Light's `menu` and `input` backgrounds are both plain white, Dracula's `input.background` is its editor background. All correct in VS Code, which separates those planes with `panel.border`; this palette leans on surface contrast instead (the four-level depth ramp in `lib/themes.ts`), so taking it literally does not give a flat theme — it gives a panel that is not there and an input field with no field. The guard fires only below a 1.02 contrast ratio, so a separation the theme *did* state, however quiet, survives: Tokyo Night's `#16161e` panel on `#1a1b26` sits at 1.06 and is pinned by a test asserting it is left byte-for-byte alone.

**One variant chosen for both halves is derived once and copied, never derived twice under opposite flags.** `buildThemeImport` branches on `lightPath === darkPath`. Running `mapVariant` twice with `isLight` true and false over the same file produces a dark palette carrying light-side rules — `scrim` taken from the foreground, `brandHover` deepening instead of lifting — a half nobody designed. Copying is the honest fallback: a dark-only extension has no light palette to infer.

**Which side a bare theme file belongs on is decided by `type` when stated and by background luminance when not.** `type` is optional in the format and **GitHub Light Default omits it**, so trusting the field alone files a white theme under "dark" — wrong, and invisible until the user switches modes.

**The backend unzips and nothing else, and it deliberately ships more files than were asked for.** `commands::themes::read_vsix` reads `extension/package.json` (always strict JSON) and hands back the raw text of every `.json` under `extension/`, within per-entry and total size caps. It does not parse a theme, because theme files are JSONC and discovering which files an `include` chain needs would mean a second JSONC parser in Rust; carrying the siblings costs a few KB and removes the requirement. Nothing is extracted to disk, so zip-slip does not apply; the caps are for zip bombs. `zip` became a direct dependency and added **nothing** to the tree — it was already in `Cargo.lock` via the Tauri updater.

**`jsonc-parser` is a dependency rather than a regex on purpose.** A comment stripper that does not track string state corrupts any value containing `//`, and colour themes are full of URLs and scope selectors.

**Monaco keeps alpha where the chrome cannot.** `editor.selectionBackground` and the line highlight are *meant* to be translucent — the app's own `huginn-dark` already ships `#2563eb59`. So editor colours pass through with their alpha intact while token rules are flattened to the bare 6-digit form Monaco throws on anything else for. Unknown colour keys are dropped rather than forwarded, because `defineTheme` validates against its own registry and one stray workbench key takes the whole theme down.

**Imported editor themes live in the theme store, not in `prefs.json` with the rest of the editor settings.** Their lifetime is the family's: one file produces one palette and one editor theme, and deleting the palette must not leave the picker offering an id nothing defines. `monaco-themes.ts` keeps a registry for `defineTheme` and for `resolveMonacoTheme` (whose `MonacoThemeId` union cannot know an imported id at compile time), but **no labels** — the Preferences picker builds its rows from the store, which React can subscribe to, instead of from a mutable `Map` it cannot.
