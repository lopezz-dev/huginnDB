import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "@/types";
import { resolveColumnCatalog } from "./columnCatalog";

const col = (name: string): ColumnInfo => ({
  name,
  data_type: "int",
  nullable: true,
  is_primary_key: false,
});

describe("resolveColumnCatalog", () => {
  it("reads the source's catalog, keyed by the name shown", () => {
    const catalog = new Map([["c", col("customer_id")]]);
    expect(resolveColumnCatalog(catalog, [col("other")])).toBe(catalog);
  });

  it("falls back to the draft row's columns without a source", () => {
    const m = resolveColumnCatalog(undefined, [col("id")]);
    expect(m.get("id")?.name).toBe("id");
  });

  it("has nothing to show with neither", () => {
    expect(resolveColumnCatalog(undefined, undefined).size).toBe(0);
  });
});
