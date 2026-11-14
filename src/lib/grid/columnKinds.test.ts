import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "@/types";
import { isAutoPkColumn, normalizeBitValue } from "./columnKinds";

const info = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type: "INTEGER",
  nullable: false,
  is_primary_key: false,
  ...over,
});
const catalogOf = (...cols: ColumnInfo[]) =>
  new Map(cols.map((c) => [c.name, c]));

describe("isAutoPkColumn", () => {
  it("is true for an integer key that is the whole key", () => {
    const id = info("TrackId", { is_primary_key: true });
    expect(isAutoPkColumn(id, catalogOf(id, info("Name", { data_type: "TEXT" })))).toBe(true);
  });

  // A junction table's key columns are values the person picks, not ones the
  // database generates: hiding them made the row impossible to insert.
  it("is false for each integer member of a composite key", () => {
    const playlist = info("PlaylistId", { is_primary_key: true });
    const track = info("TrackId", { is_primary_key: true });
    const catalog = catalogOf(playlist, track);
    expect(isAutoPkColumn(playlist, catalog)).toBe(false);
    expect(isAutoPkColumn(track, catalog)).toBe(false);
  });

  it("is false for a non-integer key, a non-key column and no catalog info", () => {
    const code = info("code", { data_type: "uuid", is_primary_key: true });
    expect(isAutoPkColumn(code, catalogOf(code))).toBe(false);
    const n = info("n");
    expect(isAutoPkColumn(n, catalogOf(n))).toBe(false);
    expect(isAutoPkColumn(undefined, new Map())).toBe(false);
  });
});

describe("normalizeBitValue", () => {
  it("maps null/undefined/empty string to empty (null)", () => {
    expect(normalizeBitValue(null)).toBe("");
    expect(normalizeBitValue(undefined)).toBe("");
    expect(normalizeBitValue("")).toBe("");
  });

  it("recognises the canonical numeric and boolean-word forms", () => {
    expect(normalizeBitValue("1")).toBe("1");
    expect(normalizeBitValue("0")).toBe("0");
    expect(normalizeBitValue("true")).toBe("1");
    expect(normalizeBitValue("false")).toBe("0");
    expect(normalizeBitValue("TRUE")).toBe("1");
    expect(normalizeBitValue("False")).toBe("0");
  });

  it("trims surrounding whitespace — pasted clipboard text often carries it", () => {
    expect(normalizeBitValue(" 1\n")).toBe("1");
    expect(normalizeBitValue("\ttrue ")).toBe("1");
  });

  it("falls back to \"1\" for anything else non-empty", () => {
    expect(normalizeBitValue("49")).toBe("1");
    expect(normalizeBitValue("yes")).toBe("1");
  });

  it("treats whitespace-only text as empty (null), not as a fallback value", () => {
    expect(normalizeBitValue("   ")).toBe("");
  });
});
