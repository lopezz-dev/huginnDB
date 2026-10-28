import { describe, expect, it } from "vitest";
import { DOCS, getDoc } from "./docs";
import {
  MAX_DOC_HITS,
  foldAligned,
  highlightRanges,
  searchDocs,
} from "./docSearch";
import { parseDoc } from "./docOutline";
import { getDocBody } from "./docs";

describe("foldAligned", () => {
  it("folds case and accents without changing the length", () => {
    expect(foldAligned("Configuración")).toBe("configuracion");
    // The point of the function: offsets in the folded string are offsets in
    // the original, so a highlight lands on the word it marks.
    for (const s of ["Línea", "İstanbul", "ÑANDÚ", "straße", "日本語"]) {
      expect(foldAligned(s)).toHaveLength(s.length);
    }
  });
});

describe("searchDocs", () => {
  it("finds a word in the page that holds it and shows the passage", () => {
    const hits = searchDocs("save_view", "en");
    // The tools table is where the MCP guide names it; the per-driver guides
    // mention it in their "Over MCP" sections too, so more than one guide hits.
    expect(hits.some((h) => h.docId === "mcp" && h.section === "tools")).toBe(true);
    expect(new Set(hits.map((h) => h.docId)).size).toBeGreaterThan(1);
    // A body match carries the passage to show, with the word marked in it.
    const body = hits.find((h) => h.docId === "mcp" && h.snippet);
    expect(body).toBeTruthy();
    const { text, ranges } = body!.snippet!;
    expect(ranges.length).toBeGreaterThan(0);
    expect(text.slice(...ranges[0]).toLowerCase()).toBe("save_view");
  });

  it("requires every word, in any order, ignoring case and accents", () => {
    const a = searchDocs("pulse sampler", "en");
    const b = searchDocs("SAMPLER Pulse", "en");
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((h) => `${h.docId}:${h.section}`)).toEqual(
      a.map((h) => `${h.docId}:${h.section}`),
    );
    expect(searchDocs("pulse zzzzqqqq", "en")).toEqual([]);
    // Spanish, typed without the accent.
    expect(searchDocs("conexion", "es").length).toBeGreaterThan(0);
  });

  it("ranks a title above a heading above body text", () => {
    const hits = searchDocs("security", "en");
    const ranks = hits.map((h) => h.rank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(hits[0].rank).toBe(0);
    // The MCP guide's own "Security" section is a title hit.
    expect(hits[0]).toMatchObject({ docId: "mcp", section: "security" });
  });

  it("points a body hit at the ### it sits under, as a slug the page has", () => {
    // Search a phrase that lives in a `###` of the MCP guide's Security section.
    // Other guides may match too, so each hit is checked against its own page.
    const hits = searchDocs("blocks the call", "en");
    const withAnchor = hits.filter((h) => h.anchor);
    expect(withAnchor.some((h) => h.docId === "mcp")).toBe(true);
    for (const h of withAnchor) {
      const page = parseDoc(getDocBody(getDoc(h.docId)!, "en"));
      const section = page.sections.find((s) => s.slug === h.section);
      expect(section?.subs.some((s) => s.slug === h.anchor)).toBe(true);
    }
  });

  it("searches the language the viewer shows", () => {
    const es = searchDocs("conexiones reservadas", "es");
    expect(es.length).toBeGreaterThan(0);
    expect(es.some((h) => h.docId === "connections")).toBe(true);
  });

  it("ignores a one-letter query and caps the list", () => {
    expect(searchDocs("a", "en")).toEqual([]);
    expect(searchDocs("   ", "en")).toEqual([]);
    expect(searchDocs("the", "en").length).toBeLessThanOrEqual(MAX_DOC_HITS);
  });

  it("only ever names a page the viewer can open", () => {
    for (const lang of ["en", "es"]) {
      for (const q of ["connection", "index", "policy", "mcp"]) {
        for (const h of searchDocs(q, lang)) {
          const doc = getDoc(h.docId);
          expect(doc).toBeTruthy();
          const parsed = parseDoc(getDocBody(doc!, lang));
          if (h.section !== null) {
            expect(parsed.sections.some((s) => s.slug === h.section)).toBe(true);
          }
        }
      }
    }
  });

  it("indexes every registered doc", () => {
    // A doc added to the registry is searchable with no further wiring — the
    // property that keeps the index from drifting from the sidebar.
    for (const doc of DOCS) {
      const parsed = parseDoc(getDocBody(doc, "en"));
      const title = parsed.sections[0]?.title;
      if (!title) continue;
      expect(
        searchDocs(title, "en").some((h) => h.docId === doc.id && h.rank === 0),
      ).toBe(true);
    }
  });
});

describe("highlightRanges", () => {
  it("marks every word wherever it appears, merged", () => {
    expect(highlightRanges("Tools and more tools", "tool")).toEqual([
      [0, 4],
      [15, 19],
    ]);
    expect(highlightRanges("Configuración", "configuracion")).toEqual([[0, 13]]);
  });
});
