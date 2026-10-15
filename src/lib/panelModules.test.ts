import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "@/stores/preferences/preferences";
import { moduleEnabled } from "./panelModules";

describe("moduleEnabled", () => {
  it("offers Pulse and the terminal out of the box, and keeps the AI opt-in", () => {
    expect(moduleEnabled(DEFAULT_PREFS, "pulse")).toBe(true);
    expect(moduleEnabled(DEFAULT_PREFS, "terminal")).toBe(true);
    expect(moduleEnabled(DEFAULT_PREFS, "ai")).toBe(false);
  });

  it("reads each module's own switch", () => {
    const prefs = {
      ...DEFAULT_PREFS,
      pulse: { ...DEFAULT_PREFS.pulse, enabled: false },
      ai: { ...DEFAULT_PREFS.ai, enabled: true },
      terminal: { ...DEFAULT_PREFS.terminal, enabled: false },
    };
    expect(moduleEnabled(prefs, "pulse")).toBe(false);
    expect(moduleEnabled(prefs, "ai")).toBe(true);
    expect(moduleEnabled(prefs, "terminal")).toBe(false);
  });
});
