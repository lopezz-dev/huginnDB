import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/locales/en.json";
import es from "@/lib/i18n/locales/es.json";
import {
  INSERT_BLOCK_KEYS,
  insertAvailability,
  insertBlockReason,
  type InsertInputs,
} from "./insertAvailability";

const table: InsertInputs = {
  pkColumnCount: 1,
  pkInResult: true,
  policyLock: null,
};

describe("insertAvailability", () => {
  it("allows an insert on a keyed table with its key in the result", () => {
    expect(insertAvailability(table)).toBeNull();
  });

  it("allows it on a composite key too", () => {
    expect(insertAvailability({ ...table, pkColumnCount: 3 })).toBeNull();
  });

  it("refuses a table without a primary key before naming the policy", () => {
    expect(
      insertAvailability({ ...table, pkColumnCount: 0, policyLock: "nope" }),
    ).toEqual({ kind: "noPk" });
  });

  it("carries the policy's own reason", () => {
    expect(insertAvailability({ ...table, policyLock: "Read-only role" })).toEqual(
      { kind: "policy", reason: "Read-only role" },
    );
  });

  it("names the policy before a projection the user could undo", () => {
    expect(
      insertAvailability({ ...table, pkInResult: false, policyLock: "nope" }),
    ).toEqual({ kind: "policy", reason: "nope" });
  });

  it("refuses when a projection hides the key", () => {
    expect(insertAvailability({ ...table, pkInResult: false })).toEqual({
      kind: "pkHidden",
    });
  });
});

describe("insertBlockReason", () => {
  const t = (key: string) => `t:${key}`;

  it("translates the structural reasons", () => {
    expect(insertBlockReason({ kind: "noPk" }, t)).toBe(
      "t:dataGrid.insertBlocked.noPk",
    );
  });

  it("passes the policy's sentence through untranslated", () => {
    expect(insertBlockReason({ kind: "policy", reason: "Locked" }, t)).toBe(
      "Locked",
    );
  });

  // `keys.test.ts` only sees `t("literal")`; these keys travel through a map.
  it.each(Object.values(INSERT_BLOCK_KEYS))("%s exists in both locales", (key) => {
    const lookup = (locale: unknown) =>
      key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          locale,
        );
    expect(typeof lookup(en)).toBe("string");
    expect(typeof lookup(es)).toBe("string");
  });
});
