import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { xtermTheme } from "./xtermTheme";

describe("xtermTheme", () => {
  const family = BUILT_IN_THEMES[0];

  it("takes the surface and the semantic colours from the palette", () => {
    for (const mode of ["light", "dark"] as const) {
      const colors = family[mode];
      const theme = xtermTheme(colors, mode);
      expect(theme.background).toBe(colors.background);
      expect(theme.foreground).toBe(colors.foreground);
      expect(theme.cursor).toBe(colors.brand);
      expect(theme.red).toBe(colors.destructive);
      expect(theme.green).toBe(colors.success);
      expect(theme.yellow).toBe(colors.warning);
      expect(theme.blue).toBe(colors.brand);
    }
  });

  it("keeps the selection translucent so the text under it still reads", () => {
    const theme = xtermTheme({ ...family.dark, brand: "#3b82f6" }, "dark");
    expect(theme.selectionBackground).toBe("#3b82f64d");
  });

  it("uses the mode's own ANSI defaults for the rest", () => {
    expect(xtermTheme(family.dark, "dark").white).toBe("#e5e5e5");
    expect(xtermTheme(family.light, "light").white).toBe("#555555");
  });
});
