---
id: 50
type: adr
status: accepted
date: 2026-08-24
tags: [docs-viewer]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #50: The docs viewer slices navigation from the markdown itself, in one scan

`docOutline.ts`'s `parseDoc` produces the outline and page bodies in a single pass so two scans can't disagree about section boundaries, skips fenced code so shell comments aren't mistaken for headings, and `slugify` follows GitHub's punctuation-dropping rule to match existing anchors.

**Decision:** The docs viewer derives cover/pages/anchors, search and the Preferences<->guides links from a single parseDoc scan of docs/*.md that skips fenced code and slugifies by GitHub's punctuation-dropping rule.

**Alternatives rejected:**

- A separate heading-lister and splitter: two passes can disagree and silently drop a paragraph.
- A bare ^# heading scan: shell comments in fenced code become phantom sections.
- Replacing punctuation in slugs: would not match existing GitHub-style anchors.
- Putting the doc->icon map in the registry: kept beside the viewer so the registry stays plain data.
- Showing a dead 'Read the guide' button for sections without a guide: no button instead.

## Detail

**The docs viewer derives its navigation from the markdown, and three things about that are load-bearing.** `docs/*.md` are still one file each, still the only source, still read on GitHub unchanged — `src/lib/appInfo/docOutline.ts` slices them at render time into a cover (everything before the first `##`), one page per `##`, and each `###` as a scroll target inside its page. So adding a section to a guide adds it to the sidebar with no code change, and the sidebar translates itself because the Spanish body carries Spanish headings.
    - **One scan produces both the outline and the bodies.** `parseDoc` returns them together rather than there being a heading-lister and a separate splitter, because two passes over the same markdown are two chances to disagree about where a section ends — and that disagreement is not an error, it is a page that quietly loses its last paragraph. There is a round-trip test over the real corpus for exactly this.
    - **The scan must skip fenced code.** `docs/MCP.md` has shell comments at lines 49 and 164 (`# binary at: …`, `# optional: startup_timeout_sec = 20`); a bare `^#` scan reads them as headings, invents phantom sections, *and* truncates the section they sit in. `docOutline`'s fence regexes are copied from `Markdown.tsx`'s deliberately, so the two cannot disagree about where a fence is.
    - **`slugify` is the join between the ids `Markdown` emits and the `#anchor`s already written in the docs**, so it follows GitHub's rule: punctuation is *dropped*, not replaced (`Sharing the app's pools` → `sharing-the-apps-pools`, never `…app-s-pools`). Duplicate-slug suffixing is scoped per rendered body in `Markdown` and per section in `parseDoc`, which is the same scope — render one section and the two agree. A test asserts every anchor in every shipped guide, in both languages, resolves.

**The viewer is a workbench built on Preferences' anatomy, and what it adds is derived from the same scan too (1.32).** `DocsDialog` opens on a home page (`activeId: null` is home, no longer "the first doc"), has a grouped `NavRailItem` rail with its own search box, a page header, an "On this page" column and a previous/next pager. Four things are load-bearing:
    - **Search reads the same outline the rail does.** `lib/appInfo/docSearch.ts` indexes `parseDoc`'s cover and `##` sections per language and maps a body hit to the `###` it sits under by counting headings with the same fence rule, so a hit's `anchor` is always a slug `ParsedDoc` has. A test asserts that for every hit in both languages. `foldAligned` folds per character and keeps the string length, because the highlight ranges are offsets into the original text.
    - **The page header owns the title, so the body drops its own heading.** `withoutHeading` removes the leading `#`/`##` line before `Markdown` renders it; anchors still resolve because `locate` works on slugs, not on the heading being drawn.
    - **`DOCS` entries of one `group` must stay adjacent**, because the rail draws a group heading each time the group changes (and the home page and the search results group the same way). A test pins it. The doc → icon map lives beside the viewer (`components/shell/docs/docIcons.ts`), not in the registry, so the registry stays plain data.
    - **Preferences ↔ guides is one table**, `lib/appInfo/settingsDocs.ts`: the "Read the guide" button in a Preferences section header and the "Open settings" button in a guide header are both derived from it. A heading deep link stores an i18n key whose *text* is a heading of the guide (slugs differ per language), and a test resolves each in both languages — renaming a heading in a guide fails the build instead of dropping the reader on the cover. Sections without a guide (General, Editor, Grid, Appearance, Notifications, About) show no button rather than a dead one.
