import { describe, expect, it, vi } from "vitest";
import { assessPassword } from "./strength";
import { createActivityReporter, isLockedError, secondsLeft } from "./status";

describe("assessPassword", () => {
  it("asks for the minimum length first", () => {
    expect(assessPassword("Short1!", 12)).toMatchObject({ ok: false, problems: ["tooShort"] });
  });

  it("refuses a long password of one kind of character", () => {
    expect(assessPassword("abcdefghijklmnop", 12).problems).toContain("oneKind");
  });

  it("refuses one character repeated", () => {
    expect(assessPassword("aaaaaaaaaaaa1", 12).problems).toContain("repetitive");
  });

  it("accepts a passphrase of words and spaces", () => {
    const s = assessPassword("correct horse battery staple", 12);
    expect(s.ok).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(2);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(assessPassword("ñandú pingüino", 12).ok).toBe(true);
    expect(assessPassword("🔒🔒🔒🔒🔒🔒", 12).problems).toContain("tooShort");
  });

  it("never scores a refused password above one", () => {
    expect(assessPassword("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 12).score).toBeLessThanOrEqual(1);
  });
});

describe("secondsLeft", () => {
  it("rounds up so a wait still owed never reads zero", () => {
    expect(secondsLeft(0)).toBe(0);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(2000)).toBe(2);
    expect(secondsLeft(2001)).toBe(3);
    expect(secondsLeft(-5)).toBe(0);
  });
});

describe("isLockedError", () => {
  it("matches the backend's tag and nothing else", () => {
    expect(isLockedError("HuginnDB is locked: open the HuginnDB app and unlock it")).toBe(true);
    expect(isLockedError(new Error("database error: locked table"))).toBe(false);
  });
});

describe("createActivityReporter", () => {
  it("reports the first activity, then at most once per interval", () => {
    let now = 1_000;
    const report = vi.fn();
    const touch = createActivityReporter(report, 30_000, () => now);
    touch();
    touch();
    expect(report).toHaveBeenCalledTimes(1);
    now += 29_999;
    touch();
    expect(report).toHaveBeenCalledTimes(1);
    now += 1;
    touch();
    expect(report).toHaveBeenCalledTimes(2);
  });
});
