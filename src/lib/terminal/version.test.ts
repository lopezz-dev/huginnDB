import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./version";

describe("isNewerVersion", () => {
  it("compares numerically, not as text", () => {
    expect(isNewerVersion("2.13.0", "2.9.2")).toBe(true);
    expect(isNewerVersion("2.9.2", "2.13.0")).toBe(false);
    expect(isNewerVersion("3.0.0", "2.99.99")).toBe(true);
    expect(isNewerVersion("2.13.1", "2.13.0")).toBe(true);
  });

  it("is not newer when equal", () => {
    expect(isNewerVersion("2.13.0", "2.13.0")).toBe(false);
  });

  it("never offers an update on a version it cannot read", () => {
    expect(isNewerVersion("2.14.0-rc.1", "2.13.0")).toBe(false);
    expect(isNewerVersion("2.14.0", "unknown")).toBe(false);
    expect(isNewerVersion("", "2.13.0")).toBe(false);
  });
});
