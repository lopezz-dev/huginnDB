import { describe, expect, it } from "vitest";
import { densityForWidth, TOOLBAR_DENSITY_BREAKPOINTS } from "./toolbarDensity";

describe("densityForWidth", () => {
  it("uses the grid toolbar's widths by default", () => {
    expect(densityForWidth(TOOLBAR_DENSITY_BREAKPOINTS.wide)).toBe("wide");
    expect(densityForWidth(TOOLBAR_DENSITY_BREAKPOINTS.wide - 1)).toBe("compact");
    expect(densityForWidth(TOOLBAR_DENSITY_BREAKPOINTS.compact - 1)).toBe("narrow");
  });

  it("takes a consumer's own widths (the query editor's toolbar)", () => {
    const query = { wide: 560, compact: 380 };
    expect(densityForWidth(600, query)).toBe("wide");
    expect(densityForWidth(400, query)).toBe("compact");
    expect(densityForWidth(300, query)).toBe("narrow");
  });
});
