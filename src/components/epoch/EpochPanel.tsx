/**
 * The right dock's Dates panel: a Unix timestamp as a readable date, in the
 * zones and formats someone actually pastes somewhere, and back.
 *
 * Two ways in, one panel: a cell's "View as date" (the grid or a document
 * field hands its value over through `useEpochPanel.openFromCell`) or the
 * activity bar, with a value pasted by hand.
 *
 * **It only ever copies.** Nothing here writes to a cell or a database — the
 * user takes the date (or the epoch) to wherever it is needed. That keeps the
 * panel outside the managed policy's reach by construction: there is no
 * operation for it to classify.
 *
 * **Layout follows the panel's own width**, not the window's: the dock is
 * dragged to any width with its sash. `epochDensityForWidth` picks one of
 * three layouts — see its doc comment — the same pattern as the grid
 * toolbar's `useToolbarDensity`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { resolveConnectionDriver } from "@/lib/connectionLabel";
import {
  EPOCH_UNITS,
  convertUnits,
  dayOfYear,
  epochDensityForWidth,
  isoInZone,
  isoUtc,
  isoWeek,
  longDate,
  offsetOf,
  parseDateText,
  relativeTo,
  sqlFor,
  toInstant,
  unitForDigits,
  wallClockToMillis,
  type EpochInstant,
  type EpochPanelDensity,
  type EpochUnit,
} from "@/lib/epoch/epoch";
import { useEpochPanel } from "@/stores/session/epoch";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";
import type { Driver } from "@/types";

const DRIVERS: Driver[] = ["mysql", "postgres", "sqlserver", "sqlite", "mongodb"];
const DRIVER_LABEL: Record<Driver, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlserver: "SQL Server",
  sqlite: "SQLite",
  mongodb: "MongoDB",
};

/** A short list for engines without `Intl.supportedValuesOf` (none of our
 *  WebViews, but tests run on jsdom). */
const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Madrid",
  "America/New_York",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

function allZones(): string[] {
  try {
    const list = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    );
    if (list && list.length > 0) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // fall through
  }
  return FALLBACK_ZONES;
}

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The panel's layout level, read by every row instead of threaded through
 *  each card as a prop. */
const DensityContext = createContext<EpochPanelDensity>("regular");

/** Past this many characters a monospaced value no longer fits beside its
 *  label at the `regular` width (an ISO string is 24–35), so the row stacks. */
const INLINE_MONO_MAX = 20;

/** Observe the panel's width and report which layout it falls into — the
 *  `useToolbarDensity` pattern: a level, not a width, so a sash drag
 *  re-renders at most twice. */
function useEpochDensity(ref: RefObject<HTMLElement | null>): EpochPanelDensity {
  const [density, setDensity] = useState<EpochPanelDensity>("regular");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === 0) return; // hidden, not narrow
      const next = epochDensityForWidth(width);
      setDensity((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    if (el.clientWidth > 0) setDensity(epochDensityForWidth(el.clientWidth));
    return () => observer.disconnect();
  }, [ref]);
  return density;
}

/**
 * "Now", taken when the panel comes on screen and again only when asked.
 *
 * Not a ticking clock: a value that changes every second under the cursor is
 * one the user cannot copy deliberately, and it re-rendered the whole panel
 * once a second for a number nobody was reading. The relative time ("36
 * minutes ago") is measured against the same instant, so the two never
 * disagree on screen.
 */
function useNow(active: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active) setNow(Date.now());
  }, [active]);
  return [now, () => setNow(Date.now())];
}

/** Copy, then show a check for a moment. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [
    copied,
    (text: string) => {
      void copyToClipboard(text).then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1100);
      });
    },
  ];
}

export function EpochPanel({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const rootRef = useRef<HTMLDivElement>(null);
  const density = useEpochDensity(rootRef);
  const [now, refreshNow] = useNow(active);

  const input = useEpochPanel((s) => s.input);
  const unitChoice = useEpochPanel((s) => s.unit);
  const source = useEpochPanel((s) => s.source);
  const approximate = useEpochPanel((s) => s.approximate);
  const setInput = useEpochPanel((s) => s.setInput);
  const setUnit = useEpochPanel((s) => s.setUnit);

  // The dialect: the source cell's own connection, else the workspace's
  // current one, else MySQL — and the user can switch it either way.
  const selectedId = useUi((s) => s.selectedConnectionId);
  const selectedDriver = useConnections((s) =>
    selectedId ? resolveConnectionDriver(s.profiles, selectedId) : undefined,
  );
  const [dialect, setDialect] = useState<Driver | null>(null);
  const driver: Driver = dialect ?? source?.driver ?? selectedDriver ?? "mysql";
  // A new cell resets a dialect picked for the previous one.
  useEffect(() => setDialect(null), [source]);

  const [zone, setZone] = useState("America/New_York");
  const zones = useMemo(allZones, []);

  const digits = input.trim();
  const valid = /^\d+$/.test(digits) && digits.length <= 19;
  const autoUnit = valid ? unitForDigits(digits) : null;
  const unit = unitChoice === "auto" ? autoUnit : unitChoice;
  const instant = valid && unit ? toInstant(digits, unit) : null;

  const narrow = density === "narrow";

  return (
    <DensityContext.Provider value={density}>
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-border px-3 py-2 text-3xs uppercase tracking-wider text-muted-foreground">
          {t("panels.dates")}
        </div>

        <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto", narrow ? "p-2" : "p-3")}>
          <SourceLine />

          <div className={cn("flex gap-1.5", narrow && "flex-col")}>
            <Input
              size="sm"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("epoch.inputPlaceholder")}
              aria-label={t("epoch.inputLabel")}
              spellCheck={false}
              inputMode="numeric"
              className="min-w-0 flex-1 font-mono"
            />
            <NativeSelect
              size="sm"
              value={unitChoice}
              onChange={(e) => setUnit(e.target.value as EpochUnit | "auto")}
              aria-label={t("epoch.unitLabel")}
              className={cn(narrow ? "w-full" : "w-auto shrink-0")}
            >
              <option value="auto">
                {autoUnit
                  ? t("epoch.unitAutoWith", { unit: t(`epoch.unitShort.${autoUnit}`) })
                  : t("epoch.unitAuto")}
              </option>
              {EPOCH_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`epoch.unit.${u}`)}
                </option>
              ))}
            </NativeSelect>
          </div>

          {approximate && (
            <p className="flex items-start gap-1.5 text-2xs text-warning">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              {t("epoch.approximate")}
            </p>
          )}

          {digits === "" ? (
            <p className="text-xs text-muted-foreground">{t("epoch.empty")}</p>
          ) : !instant ? (
            <p className="text-xs text-warning">{t("epoch.invalid")}</p>
          ) : (
            <div
              className={cn(
                // Wide: the hero, Formats and SQL span both columns; Zones and
                // the date → epoch card pair up in one row. `dense` packs that
                // pair without reordering the DOM, so a single column keeps
                // reading top to bottom in the same order.
                "grid gap-3",
                density === "wide" ? "grid-flow-row-dense grid-cols-2" : "grid-cols-1",
              )}
            >
              <HeroCard instant={instant} now={now} locale={locale} wide={density === "wide"} />
              <Card title={t("epoch.zones")} compact={density === "wide"}>
                <CopyRow label="UTC" value={longDate(instant.millis, "UTC", locale)} />
                <div className="px-1.5 py-1">
                  <NativeSelect
                    size="xs"
                    value={zone}
                    onChange={(e) => setZone(e.target.value)}
                    aria-label={t("epoch.otherZone")}
                    className="w-full"
                  >
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <CopyRow
                 
                  label={zone.split("/").pop()!.replace(/_/g, " ")}
                  value={longDate(instant.millis, zone, locale)}
                  suffix={`UTC${offsetOf(instant.millis, zone)}`}
                />
              </Card>
              <Card title={t("epoch.formats")} className={cn(density === "wide" && "col-span-2")}>
                <CopyRow
                  mono
                  label={t("epoch.isoUtc")}
                  value={isoUtc(instant)}
                  display={<IsoText iso={isoUtc(instant)} />}
                />
                <CopyRow
                  mono
                  label={t("epoch.isoLocal")}
                  value={isoInZone(instant, LOCAL_ZONE)}
                  display={<IsoText iso={isoInZone(instant, LOCAL_ZONE)} />}
                />
                <CopyRow mono label={t("epoch.unit.s")} value={convertUnits(instant, "s")} />
                <CopyRow mono label={t("epoch.unit.ms")} value={convertUnits(instant, "ms")} />
                {(instant.unit === "us" || instant.unit === "ns") && (
                  <CopyRow
                   
                    mono
                    label={t(`epoch.unit.${instant.unit}`)}
                    value={instant.digits}
                  />
                )}
                <InfoRow label={t("epoch.calendar")}>
                  {t("epoch.calendarValue", {
                    day: dayOfYear(instant.millis),
                    week: isoWeek(instant.millis),
                  })}
                </InfoRow>
              </Card>
              <Card title={t("epoch.inSql")} className={cn(density === "wide" && "col-span-2")}>
                <div className="px-1.5 py-1">
                  <NativeSelect
                    size="xs"
                    value={driver}
                    onChange={(e) => setDialect(e.target.value as Driver)}
                    aria-label={t("epoch.dialect")}
                    className="w-full"
                  >
                    {DRIVERS.map((d) => (
                      <option key={d} value={d}>
                        {DRIVER_LABEL[d]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <SqlRows instant={instant} driver={driver} column={source?.column} />
              </Card>
              <InverseCard seed={instant.millis} />
            </div>
          )}
        </div>

        <NowBar now={now} onRefresh={refreshNow} />
      </div>
    </DensityContext.Provider>
  );
}

/** Where the value came from, or a hint that it can be pasted. */
function SourceLine() {
  const { t } = useTranslation();
  const source = useEpochPanel((s) => s.source);
  if (!source) {
    return <p className="text-2xs text-muted-foreground">{t("epoch.pasteHint")}</p>;
  }
  const where = source.relation ? `${source.relation}.${source.column}` : source.column;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
      <span>{t("epoch.from")}</span>
      <span className="max-w-full truncate rounded bg-brand/10 px-1.5 py-px font-mono text-brand">
        {where}
      </span>
      {source.row && (
        <span className="max-w-full truncate rounded bg-brand/10 px-1.5 py-px font-mono text-brand">
          {source.row}
        </span>
      )}
    </div>
  );
}

/** A titled group. `compact` is for a card sharing a row in the wide
 *  layout: half the panel is narrower than the regular single column, so its
 *  rows lay out as they would in a narrow panel. */
function Card({
  title,
  children,
  className,
  compact,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const section = (
    <section className={cn("min-w-0 rounded-md border border-border bg-muted/30 pb-1", className)}>
      <h3 className="px-2.5 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
  return compact ? (
    <DensityContext.Provider value="narrow">{section}</DensityContext.Provider>
  ) : (
    section
  );
}

/** The local date, large, with its two copy buttons in plain sight. */
function HeroCard({
  instant,
  now,
  locale,
  wide,
}: {
  instant: EpochInstant;
  now: number;
  locale: string;
  wide: boolean;
}) {
  const { t } = useTranslation();
  const narrow = useContext(DensityContext) === "narrow";
  const local = longDate(instant.millis, LOCAL_ZONE, locale);
  const [copiedDate, copyDate] = useCopied();
  const [copiedIso, copyIso] = useCopied();
  return (
    <Card title={t("epoch.localTime")} className={cn(wide && "col-span-2")}>
      <div className="flex flex-col gap-2 px-2.5 pb-2">
        <p className={cn("font-medium leading-snug [overflow-wrap:anywhere]", narrow ? "text-sm" : "text-base")}>
          {local}
        </p>
        <p className="text-2xs text-muted-foreground">
          {`${LOCAL_ZONE} · UTC${offsetOf(instant.millis, LOCAL_ZONE)} · ${relativeTo(instant.millis, now, locale)}`}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            icon={copiedDate ? Check : Copy}
            onClick={() => copyDate(local)}
            className={cn(narrow && "flex-1")}
          >
            {copiedDate ? t("epoch.copied") : t("epoch.copyDate")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            icon={copiedIso ? Check : Copy}
            onClick={() => copyIso(isoInZone(instant, LOCAL_ZONE))}
            className={cn(narrow && "flex-1")}
          >
            ISO
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * A label/value row that copies its value on click — the whole row is the
 * button, so the target is never a 13px icon. `narrow` stacks the label over
 * the value; otherwise they share a line with the label in a fixed column.
 */
function CopyRow({
  label,
  value,
  suffix,
  mono,
  display,
}: {
  label: string;
  value: string;
  suffix?: string;
  mono?: boolean;
  /** What to show when it differs from what is copied (break points). */
  display?: ReactNode;
}) {
  const { t } = useTranslation();
  const density = useContext(DensityContext);
  // Stacked: label over value. Always when narrow; at the regular width only
  // for a long monospaced value, which would otherwise break mid-token.
  const narrow =
    density === "narrow" ||
    (density === "regular" && !!mono && value.length > INLINE_MONO_MAX);
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <Button
      variant="ghost"
      flat
      onClick={() => copy(value)}
      aria-label={t("epoch.copyRow", { label })}
      className={cn(
        "group grid h-auto w-full items-center gap-x-2 gap-y-0.5 rounded-sm px-2.5 py-1 text-left font-normal",
        narrow ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[5.5rem_minmax(0,1fr)_auto]",
      )}
    >
      <span
        className={cn(
          "truncate text-muted-foreground",
          narrow ? "col-span-2 text-3xs uppercase tracking-wider" : "text-2xs",
        )}
      >
        {label}
      </span>
      <span className={cn("min-w-0 whitespace-normal text-xs tabular-nums [overflow-wrap:anywhere]", mono && "font-mono")}>
        {display ?? value}
        {suffix && <span className="ml-1 whitespace-nowrap text-2xs text-muted-foreground">{suffix}</span>}
      </span>
      <Icon
        aria-hidden
        className={cn(
          "h-3 w-3 shrink-0",
          copied ? "text-success" : "text-muted-foreground/60 group-hover:text-foreground",
        )}
      />
    </Button>
  );
}

/** An ISO string that may wrap only between its date and its time — a
 *  narrow panel otherwise breaks it at the date's first hyphen. */
function IsoText({ iso }: { iso: string }) {
  const at = iso.indexOf("T");
  if (at < 0) return <>{iso}</>;
  return (
    <>
      <span className="whitespace-nowrap">{iso.slice(0, at)}</span>
      <wbr />
      <span className="whitespace-nowrap">{iso.slice(at)}</span>
    </>
  );
}

/** A label/value pair with nothing to copy. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  const narrow = useContext(DensityContext) === "narrow";
  return (
    <div
      className={cn(
        "grid gap-x-2 px-2.5 py-1 text-xs text-muted-foreground",
        narrow ? "grid-cols-1" : "grid-cols-[5.5rem_minmax(0,1fr)]",
      )}
    >
      <span className={cn(narrow ? "text-3xs uppercase tracking-wider" : "text-2xs")}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function SqlRows({
  instant,
  driver,
  column,
}: {
  instant: EpochInstant;
  driver: Driver;
  column: string | undefined;
}) {
  const { t } = useTranslation();
  const sql = sqlFor(driver, column ?? t("epoch.columnPlaceholder"), instant);
  return (
    <>
      <CopyRow mono label={t("epoch.literal")} value={sql.literal} />
      <CopyRow mono label={t("epoch.expression")} value={sql.expression} />
    </>
  );
}

/** Date → epoch, two ways: a date and time read as local or UTC, or a pasted
 *  ISO/RFC 2822 string. Both end in copy rows — never in a write. */
function InverseCard({ seed }: { seed: number }) {
  const { t, i18n } = useTranslation();
  const density = useContext(DensityContext);
  const wide = density === "wide";
  // The pickers stack when the panel is narrow, and inside the wide layout's
  // half-width card, where two of them side by side clip the time.
  const narrow = density === "narrow" || wide;
  const [zone, setZone] = useState<"local" | "utc">("local");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [text, setText] = useState("");

  // Seed the pickers from the instant being shown, so "this, a day later" is
  // one edit away. Re-seeded when a new value arrives, not on every tick.
  useEffect(() => {
    const d = new Date(seed);
    const pad = (n: number) => String(n).padStart(2, "0");
    setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    setZone("local");
  }, [seed]);

  const fromPickers = wallClockToMillis(date, time, zone);
  const fromText = parseDateText(text);

  return (
    <Card title={t("epoch.toEpoch")} compact={wide}>
      <div className="flex flex-col gap-1.5 px-2.5 pb-1.5">
        <div className={cn("grid gap-1.5", narrow ? "grid-cols-1" : "grid-cols-2")}>
          <DatePicker
            size="xs"
            value={date}
            onChange={setDate}
            locale={i18n.language}
            labels={{
              field: t("epoch.date"),
              previousMonth: t("epoch.previousMonth"),
              nextMonth: t("epoch.nextMonth"),
            }}
            className="w-full"
          />
          <TimePicker
            size="xs"
            value={time}
            onChange={setTime}
            labels={{
              hours: t("epoch.hours"),
              minutes: t("epoch.minutes"),
              seconds: t("epoch.seconds"),
            }}
            className="w-full"
          />
        </div>
        <div>
          <Segmented
            size="sm"
            value={zone}
            onValueChange={setZone}
            aria-label={t("epoch.readAs")}
            options={[
              { value: "local", label: t("epoch.local") },
              { value: "utc", label: "UTC" },
            ]}
          />
        </div>
      </div>
      {fromPickers !== null && <EpochRows millis={fromPickers} />}
      <div className="px-2.5 pb-1 pt-1.5">
        <Input
          size="xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="2026-11-05T10:46:33Z"
          aria-label={t("epoch.dateText")}
          className="font-mono"
        />
      </div>
      {text.trim() === "" ? (
        <p className="px-2.5 pb-1 text-2xs text-muted-foreground">{t("epoch.dateTextHint")}</p>
      ) : fromText === null ? (
        <p className="px-2.5 pb-1 text-2xs text-warning">{t("epoch.dateTextInvalid")}</p>
      ) : (
        <EpochRows millis={fromText} />
      )}
    </Card>
  );
}

function EpochRows({ millis }: { millis: number }) {
  const { t } = useTranslation();
  return (
    <>
      <CopyRow mono label={t("epoch.unit.s")} value={String(Math.floor(millis / 1000))} />
      <CopyRow mono label={t("epoch.unit.ms")} value={String(millis)} />
    </>
  );
}

function NowBar({ now, onRefresh }: { now: number; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [copied, copy] = useCopied();
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
      <span>{t("epoch.now")}</span>
      <span className="min-w-0 truncate font-mono text-foreground tabular-nums">{now}</span>
      <IconButton
        size="xs"
        icon={RotateCw}
        label={t("epoch.refreshNow")}
        onClick={onRefresh}
        className="ml-auto"
      />
      <Button
        size="xs"
        variant="quiet"
        icon={copied ? Check : Copy}
        // The number on screen, not a fresh `Date.now()`: what is copied is
        // what the user read.
        onClick={() => copy(String(now))}
        className="h-6 px-1.5"
      >
        {copied ? t("epoch.copied") : t("epoch.copy")}
      </Button>
    </div>
  );
}
