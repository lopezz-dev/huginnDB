/**
 * Changelog access for the in-app "What's new" panel.
 *
 * Both CHANGELOG.md (English, authoritative) and CHANGELOG.es.md (Spanish,
 * maintained for the recent releases) are bundled at build time via Vite's
 * `?raw` import (as lazily loaded chunks) — no network, no HTTP plugin. CHANGELOG.md's pre-1.0 (0.x)
 * history was pruned once the file grew too large to be a useful in-app
 * reader; the full early history still lives in git tags/commits. The
 * Spanish file may lag behind on older versions; `loadReleases("es")`
 * therefore keeps the English version list + order and substitutes the
 * Spanish body only where it exists, falling back to English per-version
 * otherwise.
 *
 * The parser is intentionally small: it understands the Keep a Changelog shape
 * this repo uses (`## [x.y.z] — date`, `### Section`, `- bullet` with wrapped
 * continuation lines) and nothing more. Inline `**bold**` is preserved in the
 * item text and rendered by the component.
 */

// The files live at the repo root. They are loaded on demand, not imported:
// the two of them are over 1.3 MB of text, which used to sit in the startup
// bundle and be parsed on every launch (and in every secondary window) for a
// panel most sessions never open. Vite emits each as its own chunk.
const loadEn = () =>
  import("../../../CHANGELOG.md?raw").then((m) => m.default);
const loadEs = () =>
  import("../../../CHANGELOG.es.md?raw").then((m) => m.default);

export interface ChangelogSection {
  /** "Added", "Changed", "Fixed", … */
  heading: string;
  items: string[];
}

export interface ChangelogRelease {
  /** "Unreleased", "1.0.3", "0.1.0-alpha", … */
  version: string;
  /** ISO date string, or null for the Unreleased section / undated entries. */
  date: string | null;
  /** Free-text paragraph(s) under the heading, before the first `###`. */
  intro: string | null;
  sections: ChangelogSection[];
}

const VERSION_RE = /^##\s+\[([^\]]+)\](?:\s+[—–-]\s+(.+))?\s*$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^\s*-\s+(.*)$/;

/** Parse one Keep-a-Changelog document into an ordered list of releases. */
export function parseChangelog(md: string): ChangelogRelease[] {
  const lines = md.split(/\r?\n/);
  const releases: ChangelogRelease[] = [];

  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let item: string[] | null = null;
  const introLines: string[] = [];

  const flushItem = () => {
    if (item && section) {
      const text = item.join(" ").trim();
      if (text) section.items.push(text);
    }
    item = null;
  };
  const flushIntro = () => {
    if (release && introLines.length) {
      const text = introLines.join("\n").trim();
      if (text) release.intro = text;
    }
    introLines.length = 0;
  };

  for (const line of lines) {
    const versionMatch = VERSION_RE.exec(line);
    if (versionMatch) {
      flushItem();
      flushIntro();
      section = null;
      release = {
        version: versionMatch[1].trim(),
        date: versionMatch[2]?.trim() ?? null,
        intro: null,
        sections: [],
      };
      releases.push(release);
      continue;
    }
    if (!release) continue; // preamble before the first version heading

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      flushItem();
      flushIntro();
      section = { heading: sectionMatch[1].trim(), items: [] };
      release.sections.push(section);
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch && section) {
      flushItem();
      item = [bulletMatch[1]];
      continue;
    }

    if (line.trim() === "") {
      // Blank line ends the current bullet; intro paragraphs keep the break.
      flushItem();
      if (!section && introLines.length) introLines.push("");
      continue;
    }

    // Continuation line: append to the open bullet, or to the intro.
    if (item) {
      item.push(line.trim());
    } else if (!section) {
      introLines.push(line.trim());
    }
  }
  flushItem();
  flushIntro();

  return releases;
}

let enCache: ChangelogRelease[] | null = null;
let esMergedCache: ChangelogRelease[] | null = null;

/**
 * Releases for the given UI language. English returns the file verbatim;
 * Spanish keeps the English version list/order and swaps in the Spanish body
 * per version where the translation exists.
 */
export async function loadReleases(lang: string): Promise<ChangelogRelease[]> {
  enCache ??= parseChangelog(await loadEn());
  if (lang !== "es") return enCache;

  if (!esMergedCache) {
    const esByVersion = new Map(
      parseChangelog(await loadEs()).map((r) => [r.version, r]),
    );
    esMergedCache = enCache.map((r) => esByVersion.get(r.version) ?? r);
  }
  return esMergedCache;
}
