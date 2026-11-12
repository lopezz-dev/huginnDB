import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/locales/en.json";
import es from "@/lib/i18n/locales/es.json";
import {
  DOCS,
  DOC_GROUPS,
  docLocation,
  docsInGroup,
  getDoc,
} from "./docs";
import {
  SETTINGS_DOCS,
  docForSettingsSection,
  resolveSettingsDoc,
  settingsSectionForDoc,
} from "./settingsDocs";

/** Resolve a dotted i18n key in a locale object. */
function lookup(locale: unknown, key: string): string | undefined {
  return key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      locale,
    ) as string | undefined;
}

describe("Preferences ↔ guides table", () => {
  it("only names guides that exist", () => {
    for (const link of SETTINGS_DOCS) expect(getDoc(link.docId)).toBeTruthy();
  });

  it("has one guide per section, so the header button is unambiguous", () => {
    const sections = SETTINGS_DOCS.map((l) => l.section);
    expect(new Set(sections).size).toBe(sections.length);
  });

  it("lands every heading on a real page, in both languages", () => {
    // The reason `headingKey` holds *text* rather than a slug: it is resolved
    // against the body the viewer will show. A guide that renames the heading
    // must fail here, not silently drop the reader on the cover.
    for (const link of SETTINGS_DOCS) {
      if (!link.headingKey) continue;
      for (const [lang, locale] of [["en", en], ["es", es]] as const) {
        const heading = lookup(locale, link.headingKey);
        expect(heading, `${link.headingKey} (${lang})`).toBeTruthy();
        const where = docLocation(link.docId, heading!, lang);
        expect(where, `${link.docId}: "${heading}" (${lang})`).not.toBeNull();
      }
    }
  });

  it("resolves to the cover when there is no heading, or none matches", async () => {
    const link = docForSettingsSection("mcp")!;
    expect(await resolveSettingsDoc(link, null, "en")).toEqual({
      id: "mcp",
      section: null,
      anchor: null,
    });
    expect((await resolveSettingsDoc(link, "No such heading anywhere", "en")).section).toBeNull();
  });

  it("finds the section for a guide and the guide for a section", () => {
    expect(settingsSectionForDoc("environments")).toBe("origins");
    expect(docForSettingsSection("origins")?.docId).toBe("environments");
    expect(settingsSectionForDoc("mongodb")).toBeUndefined();
    // Sections that are knobs rather than features have no guide, and the
    // header shows no button there instead of a dead one.
    expect(docForSettingsSection("appearance")).toBeUndefined();
  });
});

describe("docs registry groups", () => {
  it("lists each group's guides contiguously, so the rail draws one heading each", () => {
    const seen: string[] = [];
    for (const d of DOCS) {
      if (seen[seen.length - 1] !== d.group) seen.push(d.group);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("draws the groups in the declared order", () => {
    const order = DOCS.map((d) => d.group).filter((g, i, a) => a.indexOf(g) === i);
    expect(order).toEqual([...DOC_GROUPS].filter((g) => order.includes(g)));
  });

  it("has a label for every group in both languages", () => {
    for (const group of DOC_GROUPS) {
      expect(lookup(en, `docs.groups.${group}`)).toBeTruthy();
      expect(lookup(es, `docs.groups.${group}`)).toBeTruthy();
      expect(docsInGroup(group).length).toBeGreaterThan(0);
    }
  });
});
