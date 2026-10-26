import { describe, expect, it } from "vitest";
import { columnAllowed, globMatches, isPattern, matchesOf, topLevelField } from "./glob";

// Mirrors `policy::resolve::glob_matches`: the interface has to predict what
// the backend will decide, so the two must agree on these cases.
describe("globMatches", () => {
  it("matches `*` as any run of characters, ignoring case", () => {
    expect(globMatches("v_invoice_*", "V_Invoice_Totals")).toBe(true);
    expect(globMatches("*", "")).toBe(true);
    expect(globMatches("a*c", "abbbc")).toBe(true);
    expect(globMatches("a*c", "abd")).toBe(false);
    expect(globMatches("estado", "ESTADO")).toBe(true);
  });

  it("takes every other character literally", () => {
    expect(globMatches("dbo.pedidos", "dbo.pedidos")).toBe(true);
    expect(globMatches("dbo.pedidos", "dboXpedidos")).toBe(false);
    expect(globMatches("a+b", "a+b")).toBe(true);
    expect(globMatches("a+b", "aab")).toBe(false);
  });

  it("ignores spaces around the pattern, as the backend trims it", () => {
    expect(globMatches("  estado ", "estado")).toBe(true);
  });
});

describe("helpers", () => {
  it("tells a pattern from a name and lists what a pattern picks", () => {
    expect(isPattern("obs_*")).toBe(true);
    expect(isPattern("estado")).toBe(false);
    expect(matchesOf("obs*", ["observaciones", "estado", "OBS_2"])).toEqual([
      "observaciones",
      "OBS_2",
    ]);
  });

  it("judges a MongoDB path by its top-level field", () => {
    expect(topLevelField("address.zip")).toBe("address");
    expect(topLevelField("status")).toBe("status");
  });

  it("reads a missing limit as every column and an empty one as none", () => {
    expect(columnAllowed(null, "anything")).toBe(true);
    expect(columnAllowed(undefined, "anything")).toBe(true);
    expect(columnAllowed([], "anything")).toBe(false);
    expect(columnAllowed(["estado", "obs*"], "Observaciones")).toBe(true);
    expect(columnAllowed(["estado"], "importe")).toBe(false);
  });
});
