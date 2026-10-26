/**
 * Which guide explains which Preferences section — and back.
 *
 * Preferences shows *what can be set*; the guides explain *what it means and
 * when to touch it*. They used to be joined by three hand-written "full guide"
 * links (MCP, Pulse, one inside Connections), which is how the other sections
 * ended up with nothing: a link only exists where someone remembered to write
 * it. One table makes the join a property of the section, so the header button
 * appears wherever a row is added here and a test can say which sections have no
 * guide instead of it being a thing nobody knows.
 *
 * `headingKey` is an i18n key whose **text is a heading in the guide** — not a
 * slug, because slugs are per language (`connection-limits` is
 * `límites-de-conexiones` in Spanish) — resolved through `docLocation` against
 * the body the viewer will actually show. A test resolves every one in both
 * languages, so a renamed heading fails the build rather than quietly dropping
 * the reader on the cover.
 */

import type { SettingsSection } from "@/components/settings/useSettingsDialog";
import { docLocation } from "./docs";

export interface SettingsDocLink {
  section: SettingsSection;
  docId: string;
  /** i18n key of the heading to land on; omitted → the guide's cover. */
  headingKey?: string;
}

export const SETTINGS_DOCS: readonly SettingsDocLink[] = [
  {
    section: "connections",
    docId: "connections",
    headingKey: "docs.settingsHeadings.connections",
  },
  { section: "shortcuts", docId: "shortcuts" },
  { section: "security", docId: "appLock" },
  { section: "jsonSchemas", docId: "jsonSchemas" },
  {
    // Shared origins are described in the environments guide, which is also
    // where the per-environment ones are told apart from them.
    section: "origins",
    docId: "environments",
    headingKey: "docs.settingsHeadings.origins",
  },
  { section: "mcp", docId: "mcp" },
  { section: "pulse", docId: "pulse" },
  { section: "ai", docId: "ai" },
  { section: "policy", docId: "policy" },
];

/** The guide that explains `section`, if there is one. */
export function docForSettingsSection(
  section: SettingsSection,
): SettingsDocLink | undefined {
  return SETTINGS_DOCS.find((l) => l.section === section);
}

/** The Preferences section a guide is about, if it has one. */
export function settingsSectionForDoc(docId: string): SettingsSection | undefined {
  return SETTINGS_DOCS.find((l) => l.docId === docId)?.section;
}

/**
 * Where in the guide `link` lands: the doc id plus the page and anchor to open
 * it on. `heading` is the translated text behind `link.headingKey`.
 */
export function resolveSettingsDoc(
  link: SettingsDocLink,
  heading: string | null,
  lang: string,
): { id: string; section: string | null; anchor: string | null } {
  const where = heading ? docLocation(link.docId, heading, lang) : null;
  return {
    id: link.docId,
    section: where?.section ?? null,
    anchor: where?.anchor ?? null,
  };
}
