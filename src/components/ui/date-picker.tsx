import * as React from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputVariants } from "@/components/ui/input";
import { CONTROL_FOCUS_TIGHT, MENU_PANEL } from "@/components/ui/styles";

/**
 * A date field and the month calendar behind it — the app's own, replacing
 * `<input type="date">`.
 *
 * The native control was the one field whose look the app did not own: its
 * popup is the WebView's (Chromium's light grey calendar on a dark theme), its
 * display format is the OS locale's rather than the UI's (`11/05/2026` in a
 * Spanish UI on an English Windows), and its parts cannot be styled at all.
 *
 * The value is an ISO calendar date, `YYYY-MM-DD`, or `""` for none — the same
 * string the native input used, so swapping one for the other changes nothing
 * at the call site. No time, no zone: a calendar date is a calendar date, and
 * reading it as an instant is the caller's decision.
 *
 * Words are props, not translations (this layer imports no i18n — see
 * `README.md`): month and weekday names come from `Intl` in `locale`, and the
 * two arrow buttons take their labels from `labels`.
 */

// ------------------------------------------------------------- date math
// Plain {y, m, d} triples in local calendar terms: nothing here ever builds
// an instant, so no time zone or DST rule can shift a day.

interface Ymd {
  y: number;
  /** 0-based, as in `Date`. */
  m: number;
  d: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function parseIsoDate(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m < 0 || m > 11 || d < 1 || d > daysIn(y, m)) return null;
  return { y, m, d };
}

export function formatIsoDate({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** The same day `n` days later (or earlier), rolling over months and years. */
function addDays(a: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(a.y, a.m, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** The same day `n` months later, clamped to the target month's length. */
function addMonths(a: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(a.y, a.m + n, 1));
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  return { y, m, d: Math.min(a.d, daysIn(y, m)) };
}

const sameDay = (a: Ymd | null, b: Ymd | null) =>
  !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;

function todayYmd(): Ymd {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}

/** 0 = Sunday … 6 = Saturday. */
const weekday = (a: Ymd) => new Date(Date.UTC(a.y, a.m, a.d)).getUTCDay();

/** Six weeks starting on the `weekStartsOn` day on or before the 1st. */
function monthGrid(y: number, m: number, weekStartsOn: number): Ymd[] {
  const first = { y, m, d: 1 };
  const lead = (weekday(first) - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Formats a calendar date through `Intl` without letting a zone move it. */
function fmt(a: Ymd, locale: string | undefined, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(
    Date.UTC(a.y, a.m, a.d),
  );
}

const capitalise = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

// --------------------------------------------------------------- Calendar

export interface CalendarLabels {
  previousMonth: string;
  nextMonth: string;
}

export interface CalendarProps {
  /** `YYYY-MM-DD`, or `""` for no selection. */
  value: string;
  onChange: (value: string) => void;
  labels: CalendarLabels;
  /** BCP 47 tag for month and weekday names; the runtime's by default. */
  locale?: string;
  /** 1 = Monday (the default — ISO 8601 and most of Europe), 0 = Sunday. */
  weekStartsOn?: 0 | 1;
  /** Move keyboard focus to the active day on mount (the popover does). */
  autoFocus?: boolean;
  className?: string;
}

/**
 * A month grid: a WAI-ARIA date grid with one day in the Tab order. Arrows
 * move by day and week, PageUp/PageDown by month, Home/End to the week's
 * edges, Enter or Space picks.
 */
export function Calendar({
  value,
  onChange,
  labels,
  locale,
  weekStartsOn = 1,
  autoFocus,
  className,
}: CalendarProps) {
  const selected = parseIsoDate(value);
  const today = React.useMemo(todayYmd, []);
  // The day that holds the Tab stop — and the month shown is always its month.
  const [active, setActive] = React.useState<Ymd>(selected ?? today);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const moved = React.useRef(!!autoFocus);

  // A new value from outside (the field was edited elsewhere) re-centres the
  // grid on it.
  React.useEffect(() => {
    const next = parseIsoDate(value);
    if (next) setActive(next);
  }, [value]);

  // Focus follows `active` once the user has started moving (or on mount
  // when asked) — never on a plain re-render, which would steal focus from
  // whatever the user is doing elsewhere.
  React.useEffect(() => {
    if (!moved.current) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${formatIsoDate(active)}"]`)
      ?.focus();
  }, [active]);

  const days = monthGrid(active.y, active.m, weekStartsOn);
  const weekdays = days.slice(0, 7).map((d) => fmt(d, locale, { weekday: "short" }));

  function move(next: Ymd) {
    moved.current = true;
    setActive(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const wd = (weekday(active) - weekStartsOn + 7) % 7;
    const step: Record<string, () => Ymd> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      PageUp: () => addMonths(active, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(active, e.shiftKey ? 12 : 1),
      Home: () => addDays(active, -wd),
      End: () => addDays(active, 6 - wd),
    };
    const go = step[e.key];
    if (!go) return;
    e.preventDefault();
    move(go());
  }

  const navButton =
    "inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <div className={cn("w-[15.5rem] select-none p-1 text-xs", className)}>
      <div className="mb-1 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label={labels.previousMonth}
          className={cn(navButton, CONTROL_FOCUS_TIGHT)}
          onClick={() => move(addMonths(active, -1))}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="font-medium" aria-live="polite">
          {capitalise(fmt(active, locale, { month: "long", year: "numeric" }))}
        </span>
        <button
          type="button"
          aria-label={labels.nextMonth}
          className={cn(navButton, CONTROL_FOCUS_TIGHT)}
          onClick={() => move(addMonths(active, 1))}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={gridRef} role="grid" onKeyDown={onKeyDown}>
        <div role="row" className="grid grid-cols-7">
          {weekdays.map((w, i) => (
            <span
              key={i}
              role="columnheader"
              className="py-1 text-center text-3xs uppercase text-muted-foreground"
            >
              {w.replace(/\.$/, "")}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="grid grid-cols-7">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const iso = formatIsoDate(day);
              const isSelected = sameDay(day, selected);
              const isActive = sameDay(day, active);
              const outside = day.m !== active.m;
              return (
                <span key={iso} role="gridcell" aria-selected={isSelected}>
                  <button
                    type="button"
                    data-day={iso}
                    tabIndex={isActive ? 0 : -1}
                    aria-label={fmt(day, locale, { dateStyle: "full" })}
                    aria-current={sameDay(day, today) ? "date" : undefined}
                    onClick={() => onChange(iso)}
                    className={cn(
                      "h-8 w-full rounded-sm tabular-nums transition-colors",
                      CONTROL_FOCUS_TIGHT,
                      outside ? "text-muted-foreground/50" : "text-foreground",
                      isSelected
                        ? "bg-brand font-medium text-brand-foreground hover:bg-brand-hover"
                        : "hover:bg-accent",
                      !isSelected &&
                        sameDay(day, today) &&
                        "font-semibold text-brand underline underline-offset-4",
                    )}
                  >
                    {day.d}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- DatePicker

export interface DatePickerProps extends Omit<CalendarProps, "autoFocus" | "className"> {
  labels: CalendarLabels & {
    /** The trigger's accessible name ("Date"). */
    field: string;
  };
  /** Shown while there is no value. */
  placeholder?: string;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/**
 * A field that shows the date in `locale`'s short numeric form and opens a
 * `Calendar` beneath it (above, when there is no room below). Esc or a click
 * outside closes it and hands focus back to the field.
 */
export const DatePicker = React.forwardRef<HTMLButtonElement, DatePickerProps>(
  (
    {
      value,
      onChange,
      labels,
      locale,
      weekStartsOn,
      placeholder,
      size = "md",
      disabled,
      className,
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
    const selected = parseIsoDate(value);

    React.useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);

    const close = React.useCallback((refocus: boolean) => {
      setOpen(false);
      if (refocus) triggerRef.current?.focus();
    }, []);

    // Fixed positioning against the trigger, recomputed when anything scrolls
    // or resizes: the field usually lives in a scrolling panel, and a portalled
    // popover does not move with it on its own.
    React.useLayoutEffect(() => {
      if (!open) return;
      function place() {
        const t = triggerRef.current?.getBoundingClientRect();
        const p = panelRef.current?.getBoundingClientRect();
        if (!t) return;
        const height = p?.height ?? 300;
        const width = p?.width ?? 256;
        const below = t.bottom + 4;
        const top =
          below + height > window.innerHeight && t.top - 4 - height > 0
            ? t.top - 4 - height
            : below;
        const left = Math.max(4, Math.min(t.left, window.innerWidth - width - 4));
        setPos({ top, left });
      }
      place();
      // Once more after the panel has a size to measure.
      const raf = requestAnimationFrame(place);
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
      };
    }, [open]);

    React.useEffect(() => {
      if (!open) return;
      function onPointerDown(e: PointerEvent) {
        const target = e.target as Node;
        if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
        close(false);
      }
      function onKey(e: KeyboardEvent) {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(true);
        }
      }
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKey, true);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    }, [open, close]);

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-label={labels.field}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            inputVariants({ size }),
            "inline-flex items-center justify-between gap-2 text-left tabular-nums",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">
            {selected
              ? fmt(selected, locale, { day: "2-digit", month: "2-digit", year: "numeric" })
              : (placeholder ?? "")}
          </span>
          <CalendarDays aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {open &&
          createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={labels.field}
              data-state="open"
              className={cn(MENU_PANEL, "fixed max-h-none")}
              style={pos ?? { visibility: "hidden", top: 0, left: 0 }}
            >
              <Calendar
                value={value}
                onChange={(v) => {
                  onChange(v);
                  close(true);
                }}
                labels={labels}
                locale={locale}
                weekStartsOn={weekStartsOn}
                autoFocus
              />
            </div>,
            document.body,
          )}
      </>
    );
  },
);
DatePicker.displayName = "DatePicker";
