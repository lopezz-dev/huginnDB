/**
 * Unix timestamps → readable dates, and back. The pure core of the "View as
 * date" cell action and the right dock's Dates panel.
 *
 * **Detection is by value only, never by column name.** The action is
 * on-demand — the user asks for it on one cell — so a heuristic over names
 * (`*_at`, `ts`, …) would only add a second way to be wrong. A value
 * qualifies when it is a positive integer (a JSON number or a digit-only
 * string), its digit count names a unit (9–10 s, 12–13 ms, 15–16 µs, 18–19
 * ns), and the instant it denotes falls in [1980, 2100]. An ID that happens
 * to pass is shown as a date the user can see is wrong; nothing is ever
 * reformatted in the grid itself.
 *
 * **Arithmetic is `BigInt` over the decimal digits**, so a nanosecond value
 * keeps all 19 digits through the conversion. `Number` appears only where
 * `Intl` needs one (millisecond precision is all a calendar can show), and in
 * `fromCellValue`, where a JSON number past 2^53 has *already* lost its tail
 * on the way from the backend — that case is flagged as `approximate` rather
 * than silently presented as exact.
 */

import type { Driver } from "@/types";

export type EpochUnit = "s" | "ms" | "us" | "ns";

export const EPOCH_UNITS: readonly EpochUnit[] = ["s", "ms", "us", "ns"];

/** Powers of ten per unit, and the number of fractional digits each carries. */
const PER_SECOND: Record<EpochUnit, bigint> = {
  s: 1n,
  ms: 1_000n,
  us: 1_000_000n,
  ns: 1_000_000_000n,
};
const FRACTION_DIGITS: Record<EpochUnit, number> = { s: 0, ms: 3, us: 6, ns: 9 };

/** The plausible window. Below 1980 a 9-digit "seconds" value is far more
 *  often a counter than a date; past 2100 nothing in a live database is. */
const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

/** Longest accepted input: a 19-digit nanosecond timestamp. */
const MAX_DIGITS = 19;

/** The unit a run of digits most likely is, by its length alone. */
export function unitForDigits(digits: string): EpochUnit | null {
  const n = digits.length;
  if (n >= 9 && n <= 10) return "s";
  if (n >= 12 && n <= 13) return "ms";
  if (n >= 15 && n <= 16) return "us";
  if (n >= 18 && n <= 19) return "ns";
  return null;
}

/** A cell value reduced to its decimal digits, or `null` when it is not a
 *  positive integer. `approximate` is set for a JSON number the backend sent
 *  past `Number.MAX_SAFE_INTEGER`, whose last digits are already gone. */
export interface EpochDigits {
  digits: string;
  approximate: boolean;
}

export function digitsOf(value: unknown): EpochDigits | null {
  if (typeof value === "bigint") {
    return value > 0n ? { digits: value.toString(), approximate: false } : null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) return null;
    // `BigInt(n)` prints every integer digit; `String(n)` switches to
    // exponent notation past 1e21 and would never match `^\d+$`.
    return {
      digits: BigInt(value).toString(),
      approximate: !Number.isSafeInteger(value),
    };
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^\d+$/.test(s) || /^0+$/.test(s)) return null;
    return { digits: s.replace(/^0+/, ""), approximate: false };
  }
  return null;
}

/** An instant split exactly: whole seconds since the epoch, the fractional
 *  digits in the source unit, and the millisecond value `Intl` can format. */
export interface EpochInstant {
  digits: string;
  unit: EpochUnit;
  seconds: bigint;
  /** Fractional part, zero-padded to the unit's width (`""` for seconds). */
  fraction: string;
  /** Milliseconds since the epoch, truncated — safe as a `Number` for any
   *  instant inside the plausible window. */
  millis: number;
}

export function toInstant(digits: string, unit: EpochUnit): EpochInstant | null {
  if (!/^\d+$/.test(digits) || digits.length > MAX_DIGITS) return null;
  const n = BigInt(digits);
  const per = PER_SECOND[unit];
  const seconds = n / per;
  const fraction =
    FRACTION_DIGITS[unit] === 0
      ? ""
      : (n % per).toString().padStart(FRACTION_DIGITS[unit], "0");
  const millis = Number((n * 1_000n) / per);
  // Outside what `Date` can represent at all (±8.64e15 ms).
  if (!Number.isFinite(millis) || millis > 8.64e15) return null;
  return { digits, unit, seconds, fraction, millis };
}

/** Whether an instant falls in the plausible window. */
export function isPlausible(instant: EpochInstant): boolean {
  const year = new Date(instant.millis).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

export interface DetectedEpoch extends EpochInstant {
  approximate: boolean;
}

/** The cell-menu gate: a detected timestamp, or `null` to hide the action. */
export function detectEpoch(value: unknown): DetectedEpoch | null {
  const d = digitsOf(value);
  if (!d) return null;
  const unit = unitForDigits(d.digits);
  if (!unit) return null;
  const instant = toInstant(d.digits, unit);
  if (!instant || !isPlausible(instant)) return null;
  return { ...instant, approximate: d.approximate };
}

/** The same instant re-expressed as whole units of `to`, exactly. */
export function convertUnits(instant: EpochInstant, to: EpochUnit): string {
  const n = BigInt(instant.digits);
  return ((n * PER_SECOND[to]) / PER_SECOND[instant.unit]).toString();
}

// ---------------------------------------------------------------- formatting

function partsIn(millis: number, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(millis)) {
    out[p.type] = p.value;
  }
  return out;
}

/** `+01:00`, `-05:00`, `+05:30`; `+00:00` for UTC. */
export function offsetOf(millis: number, timeZone: string): string {
  let name = "GMT";
  try {
    name =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(millis)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  } catch {
    // An engine without `longOffset` (none of our WebViews, but jsdom may
    // lag): fall back to the short form, which still reads `GMT+1`.
    name =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
        .formatToParts(millis)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  }
  const raw = name.replace("GMT", "");
  if (raw === "") return "+00:00";
  // `shortOffset` gives `+1` / `+5:30`; normalise to `±HH:MM`.
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  return m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : raw;
}

const withFraction = (fraction: string) => (fraction ? `.${fraction}` : "");

/** ISO 8601 in UTC with the source unit's full fraction: `…T10:46:33.123456789Z`. */
export function isoUtc(instant: EpochInstant): string {
  const p = partsIn(Number(instant.seconds) * 1000, "UTC");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${withFraction(instant.fraction)}Z`;
}

/** ISO 8601 with the zone's own offset: `…T11:46:33.000+01:00`. */
export function isoInZone(instant: EpochInstant, timeZone: string): string {
  const millis = Number(instant.seconds) * 1000;
  const p = partsIn(millis, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${withFraction(instant.fraction)}${offsetOf(millis, timeZone)}`;
}

/** `jueves, 5 de noviembre de 2026, 11:46:33` in the UI's locale. */
export function longDate(millis: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(millis);
}

/** The menu's right-hand preview: `5 nov 2026, 11:46`, local time. */
export function shortDate(millis: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(millis);
}

/** `hace 9 segundos`, `dentro de 3 días`, in the UI's locale. */
export function relativeTo(millis: number, now: number, locale: string): string {
  const diffSec = (millis - now) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const steps: [number, Intl.RelativeTimeFormatUnit, number][] = [
    [60, "second", 1],
    [3_600, "minute", 60],
    [86_400, "hour", 3_600],
    [2_592_000, "day", 86_400],
    [31_536_000, "month", 2_592_000],
    [Infinity, "year", 31_536_000],
  ];
  for (const [limit, unit, div] of steps) {
    if (abs < limit) return rtf.format(Math.round(diffSec / div), unit);
  }
  return rtf.format(Math.round(diffSec / 31_536_000), "year");
}

/** 1-based day of the year, in UTC. */
export function dayOfYear(millis: number): number {
  const d = new Date(millis);
  return (
    Math.floor(
      (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(d.getUTCFullYear(), 0, 1)) /
        86_400_000,
    ) + 1
  );
}

/** ISO 8601 week number (weeks start on Monday; week 1 holds the first Thursday), in UTC. */
export function isoWeek(millis: number): number {
  const d = new Date(millis);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

// ------------------------------------------------------------------- SQL

/** A copy-ready literal for the instant and an expression turning the column
 *  itself into a date, in the connection's own dialect. Both assume UTC —
 *  the epoch is UTC by definition, and the literal says so where the dialect
 *  allows it. */
export interface EpochSql {
  literal: string;
  expression: string;
}

const DIVISOR: Record<EpochUnit, string> = {
  s: "",
  ms: " / 1000",
  us: " / 1000000",
  ns: " / 1000000000",
};

export function sqlFor(driver: Driver, column: string, instant: EpochInstant): EpochSql {
  const iso = isoUtc(instant);
  // `YYYY-MM-DD HH:MM:SS[.fff]` — what every SQL dialect here parses.
  const plain = iso.slice(0, -1).replace("T", " ");
  const div = DIVISOR[instant.unit];
  switch (driver) {
    case "mysql":
      return { literal: `'${plain}'`, expression: `FROM_UNIXTIME(${column}${div})` };
    case "postgres":
      return {
        literal: `TIMESTAMPTZ '${plain}+00'`,
        expression:
          instant.unit === "s"
            ? `to_timestamp(${column})`
            : `to_timestamp(${column}${div}.0)`,
      };
    case "sqlserver":
      return {
        literal: `'${plain}'`,
        // `DATEADD` takes an `int`, which a millisecond count overflows — so
        // whole seconds go in one call and the remainder in another.
        expression:
          instant.unit === "s"
            ? `DATEADD(SECOND, ${column}, '1970-01-01')`
            : instant.unit === "ms"
              ? `DATEADD(MILLISECOND, ${column} % 1000, DATEADD(SECOND, ${column} / 1000, '1970-01-01'))`
              : `DATEADD(SECOND, ${column}${div}, '1970-01-01')`,
      };
    case "sqlite":
      return { literal: `'${plain}'`, expression: `datetime(${column}${div}, 'unixepoch')` };
    case "mongodb": {
      const field = `"$${column}"`;
      const expression =
        instant.unit === "ms"
          ? `{ $toDate: ${field} }`
          : instant.unit === "s"
            ? `{ $toDate: { $multiply: [${field}, 1000] } }`
            : `{ $toDate: { $divide: [${field}, ${instant.unit === "us" ? 1000 : 1000000}] } }`;
      // `ISODate` keeps milliseconds only; anything finer is dropped there.
      return { literal: `ISODate("${new Date(instant.millis).toISOString()}")`, expression };
    }
  }
}

// --------------------------------------------------------- date → epoch

/** Milliseconds for a wall-clock date read either as local time or as UTC. */
export function wallClockToMillis(
  date: string,
  time: string,
  zone: "local" | "utc",
): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time || "00:00:00");
  if (!d || !t) return null;
  const [y, mo, da] = [Number(d[1]), Number(d[2]) - 1, Number(d[3])];
  const [h, mi, s] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  const ms =
    zone === "utc"
      ? Date.UTC(y, mo, da, h, mi, s)
      : new Date(y, mo, da, h, mi, s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A pasted date: ISO 8601 / RFC 3339 and RFC 2822 — what `Date.parse` is
 *  specified (ISO) or reliably implemented (RFC 2822) to read. Anything
 *  looser is refused rather than guessed: `03/04/2026` is March in one
 *  locale and April in the other. */
export function parseDateText(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const looksIso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s);
  const looksRfc2822 = /^([A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(:\d{2})?\s*(GMT|UTC|Z|[+-]\d{4})?$/.test(s);
  if (!looksIso && !looksRfc2822) return null;
  const ms = Date.parse(looksIso ? s.replace(" ", "T") : s);
  return Number.isNaN(ms) ? null : ms;
}

// --------------------------------------------------------------- density

/**
 * The panel lives in a dock the user drags to any width, so its layout keys
 * off its own width — the `toolbarDensity` pattern, not a media query.
 *
 * - `narrow` (< 320): labels stack above values, controls go full width.
 * - `regular` (320–479): label and value share a row. The default dock width.
 * - `wide` (≥ 480): secondary cards split into two columns.
 */
export type EpochPanelDensity = "narrow" | "regular" | "wide";

export const EPOCH_DENSITY_BREAKPOINTS = { wide: 480, regular: 320 } as const;

export function epochDensityForWidth(width: number): EpochPanelDensity {
  if (width >= EPOCH_DENSITY_BREAKPOINTS.wide) return "wide";
  if (width >= EPOCH_DENSITY_BREAKPOINTS.regular) return "regular";
  return "narrow";
}
