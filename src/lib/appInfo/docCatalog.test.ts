import { describe, expect, it } from "vitest";

import { DOC_IDS, docDescriptionKey, docTitleKey } from "./docCatalog";
import { DOCS } from "./docs";

// The catalog exists so always-mounted code can name the guides without
// importing their text; it is only correct while it mirrors the registry.
describe("DOC_IDS", () => {
  it("lists the registry's docs, in the registry's order", () => {
    expect([...DOC_IDS]).toEqual(DOCS.map((d) => d.id));
  });

  it("derives the same i18n keys the registry declares", () => {
    for (const doc of DOCS) {
      expect(docTitleKey(doc.id)).toBe(doc.titleKey);
      expect(docDescriptionKey(doc.id)).toBe(doc.descriptionKey);
    }
  });
});
