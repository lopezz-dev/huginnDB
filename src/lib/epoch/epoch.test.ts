import { describe, expect, it } from "vitest";
import {
  convertUnits,
  dayOfYear,
  detectEpoch,
  digitsOf,
  epochDensityForWidth,
  isoInZone,
  isoUtc,
  isoWeek,
  offsetOf,
  parseDateText,
  relativeTo,
  sqlFor,
  toInstant,
  unitForDigits,
  wallClockToMillis,
} from "./epoch";

// 2026-11-05T10:46:33Z — the example from the request.
const SEC = "1793875593";
const MS = "1793875593000";

describe("unitForDigits", () => {
  it.each([
    ["123456789", "s"],
    [SEC, "s"],
    ["179387559312", "ms"],
    [MS, "ms"],
    ["1793875593000000", "us"],
    ["1793875593123456789", "ns"],
  ])("%s → %s", (digits, unit) => {
    expect(unitForDigits(digits)).toBe(unit);
  });

  it.each(["12345678", "17938755930", "17938755930000", "17938755930000000", "12345678901234567890"])(
    "has no unit for the gaps between ranges (%s)",
    (digits) => {
      expect(unitForDigits(digits)).toBeNull();
    },
  );
});

describe("digitsOf", () => {
  it("accepts positive integers in every shape the backend sends", () => {
    expect(digitsOf(1793875593)).toEqual({ digits: SEC, approximate: false });
    expect(digitsOf(MS)).toEqual({ digits: MS, approximate: false });
    expect(digitsOf("  0001793875593 ")).toEqual({ digits: SEC, approximate: false });
    expect(digitsOf(1793875593123456789n)).toEqual({
      digits: "1793875593123456789",
      approximate: false,
    });
  });

  it("flags a JSON number that already lost precision past 2^53", () => {
    const d = digitsOf(1793875593123456789);
    expect(d?.approximate).toBe(true);
    expect(d?.digits).toMatch(/^\d{19}$/);
  });

  it.each([null, undefined, 0, -1793875593, 1793875593.5, "", "0", "17938a", "-1793875593", true, {}])(
    "rejects %p",
    (value) => {
      expect(digitsOf(value)).toBeNull();
    },
  );
});

describe("detectEpoch", () => {
  it("detects seconds and milliseconds to the same instant", () => {
    const s = detectEpoch(1793875593);
    const ms = detectEpoch(MS);
    expect(s?.unit).toBe("s");
    expect(ms?.unit).toBe("ms");
    expect(s?.millis).toBe(1793875593000);
    expect(ms?.millis).toBe(1793875593000);
  });

  it("keeps nanosecond digits exact when they arrive as text", () => {
    const ns = detectEpoch("1793875593123456789");
    expect(ns?.unit).toBe("ns");
    expect(ns?.seconds).toBe(1793875593n);
    expect(ns?.fraction).toBe("123456789");
    expect(ns?.millis).toBe(1793875593123);
  });

  it("rejects values outside 1980–2100 and plain counters", () => {
    expect(detectEpoch(48211)).toBeNull(); // an id
    expect(detectEpoch(45000)).toBeNull(); // a duration
    expect(detectEpoch(100000000)).toBeNull(); // 1973
    expect(detectEpoch(9999999999)).toBeNull(); // 2286
  });
});

describe("conversions and formats", () => {
  const ms = toInstant(MS, "ms")!;
  const ns = toInstant("1793875593123456789", "ns")!;

  it("converts between units exactly", () => {
    expect(convertUnits(ms, "s")).toBe(SEC);
    expect(convertUnits(ms, "ns")).toBe("1793875593000000000");
    expect(convertUnits(ns, "ms")).toBe("1793875593123");
  });

  it("writes ISO with the source unit's full fraction", () => {
    expect(isoUtc(toInstant(SEC, "s")!)).toBe("2026-11-05T10:46:33Z");
    expect(isoUtc(ms)).toBe("2026-11-05T10:46:33.000Z");
    expect(isoUtc(ns)).toBe("2026-11-05T10:46:33.123456789Z");
  });

  it("writes ISO in a zone with its own offset", () => {
    expect(isoInZone(ms, "Europe/Madrid")).toBe("2026-11-05T11:46:33.000+01:00");
    expect(isoInZone(ms, "America/New_York")).toBe("2026-11-05T05:46:33.000-05:00");
    expect(isoInZone(ms, "Asia/Kolkata")).toBe("2026-11-05T16:16:33.000+05:30");
  });

  it("names offsets as ±HH:MM, UTC included", () => {
    expect(offsetOf(ms.millis, "UTC")).toBe("+00:00");
    expect(offsetOf(ms.millis, "Europe/Madrid")).toBe("+01:00");
    // Summer time in Madrid.
    expect(offsetOf(Date.UTC(2026, 6, 1), "Europe/Madrid")).toBe("+02:00");
  });

  it("computes calendar facts in UTC", () => {
    expect(dayOfYear(ms.millis)).toBe(309);
    expect(isoWeek(ms.millis)).toBe(45);
    // 1 Jan 2027 is a Friday: still week 53 of 2026.
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe(53);
  });

  it("phrases the distance to now in the UI locale", () => {
    expect(relativeTo(ms.millis, ms.millis + 9_000, "es")).toBe("hace 9 segundos");
    expect(relativeTo(ms.millis, ms.millis - 3 * 86_400_000, "en")).toBe("in 3 days");
  });
});

describe("sqlFor", () => {
  const ms = toInstant(MS, "ms")!;
  const s = toInstant(SEC, "s")!;

  it("turns the column into a date in each dialect", () => {
    expect(sqlFor("mysql", "created_at", ms).expression).toBe("FROM_UNIXTIME(created_at / 1000)");
    expect(sqlFor("postgres", "created_at", s).expression).toBe("to_timestamp(created_at)");
    expect(sqlFor("postgres", "created_at", ms).expression).toBe("to_timestamp(created_at / 1000.0)");
    expect(sqlFor("sqlite", "created_at", ms).expression).toBe("datetime(created_at / 1000, 'unixepoch')");
    expect(sqlFor("sqlserver", "created_at", ms).expression).toContain("DATEADD(MILLISECOND");
    expect(sqlFor("mongodb", "created_at", ms).expression).toBe('{ $toDate: "$created_at" }');
  });

  it("gives a UTC literal", () => {
    expect(sqlFor("mysql", "c", ms).literal).toBe("'2026-11-05 10:46:33.000'");
    expect(sqlFor("postgres", "c", s).literal).toBe("TIMESTAMPTZ '2026-11-05 10:46:33+00'");
    expect(sqlFor("mongodb", "c", ms).literal).toBe('ISODate("2026-11-05T10:46:33.000Z")');
  });
});

describe("date → epoch", () => {
  it("reads a wall-clock date as UTC", () => {
    expect(wallClockToMillis("2026-11-05", "10:46:33", "utc")).toBe(1793875593000);
    expect(wallClockToMillis("2026-11-05", "10:46", "utc")).toBe(1793875560000);
    expect(wallClockToMillis("05/11/2026", "10:46", "utc")).toBeNull();
  });

  it("parses ISO and RFC 2822, and refuses ambiguous formats", () => {
    expect(parseDateText("2026-11-05T10:46:33Z")).toBe(1793875593000);
    expect(parseDateText("2026-11-05T11:46:33+01:00")).toBe(1793875593000);
    expect(parseDateText("Thu, 05 Nov 2026 10:46:33 GMT")).toBe(1793875593000);
    expect(parseDateText("03/04/2026")).toBeNull();
    expect(parseDateText("mañana")).toBeNull();
    expect(parseDateText("")).toBeNull();
  });
});

describe("epochDensityForWidth", () => {
  it.each([
    [240, "narrow"],
    [319, "narrow"],
    [320, "regular"],
    [372, "regular"],
    [479, "regular"],
    [480, "wide"],
  ])("%d px → %s", (w, d) => {
    expect(epochDensityForWidth(w)).toBe(d);
  });
});
