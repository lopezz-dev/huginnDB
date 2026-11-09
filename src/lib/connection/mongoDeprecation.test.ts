import { describe, expect, it } from "vitest";
import { isLegacyMongoVersion, mongoVersionNumber } from "./mongoDeprecation";

describe("isLegacyMongoVersion", () => {
  it("flags servers older than 4.4", () => {
    expect(isLegacyMongoVersion("mongodb 4.2.24")).toBe(true);
    expect(isLegacyMongoVersion("mongodb 4.0.28")).toBe(true);
    expect(isLegacyMongoVersion("mongodb 3.6.23")).toBe(true);
  });

  it("leaves 4.4 and later alone", () => {
    expect(isLegacyMongoVersion("mongodb 4.4.0")).toBe(false);
    expect(isLegacyMongoVersion("mongodb 5.0.31")).toBe(false);
    expect(isLegacyMongoVersion("mongodb 8.0.4")).toBe(false);
  });

  it("stays quiet on anything it cannot read", () => {
    expect(isLegacyMongoVersion("mongodb ?")).toBe(false);
    expect(isLegacyMongoVersion("mysql 5.7.44")).toBe(false);
    expect(isLegacyMongoVersion("")).toBe(false);
  });
});

describe("mongoVersionNumber", () => {
  it("drops the driver prefix", () => {
    expect(mongoVersionNumber("mongodb 4.2.24")).toBe("4.2.24");
  });
});
