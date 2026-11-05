import * as React from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputVariants } from "@/components/ui/input";
import { fieldFocus } from "@/components/ui/styles";

/**
 * A 24-hour time field — the app's own, replacing `<input type="time">`.
 *
 * The native control renders in the OS locale's clock, so a Spanish UI on an
 * English Windows showed `11:46:33 AM` and clipped the `AM` in a narrow panel;
 * and its spin segments cannot be styled. A database stores 24-hour times, and
 * so does this field, always.
 *
 * The value is `HH:MM:SS` (or `HH:MM` with `seconds={false}`) — the same string
 * the native input produced. Each segment is its own input: type two digits and
 * focus moves on, a first digit that can only start one value (a `7` in the
 * hours) moves on at once, ArrowUp/ArrowDown step with wrap-around, and
 * Backspace in an empty segment goes back to the previous one.
 */

type Segment = "h" | "m" | "s";

const MAX: Record<Segment, number> = { h: 23, m: 59, s: 59 };

const pad = (n: number) => String(n).padStart(2, "0");

export function parseTime(value: string): Record<Segment, number> {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
  if (!match) return { h: 0, m: 0, s: 0 };
  const clamp = (n: number, seg: Segment) => Math.min(MAX[seg], Math.max(0, n));
  return {
    h: clamp(Number(match[1]), "h"),
    m: clamp(Number(match[2]), "m"),
    s: clamp(Number(match[3] ?? 0), "s"),
  };
}

export interface TimePickerLabels {
  hours: string;
  minutes: string;
  seconds: string;
}

export interface TimePickerProps {
  /** `HH:MM:SS`, or `HH:MM` when `seconds` is false. */
  value: string;
  onChange: (value: string) => void;
  labels: TimePickerLabels;
  /** Show and emit the seconds segment. Default true. */
  seconds?: boolean;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  className?: string;
}

export function TimePicker({
  value,
  onChange,
  labels,
  seconds = true,
  size = "md",
  disabled,
  className,
}: TimePickerProps) {
  const parts = parseTime(value);
  const segments: Segment[] = seconds ? ["h", "m", "s"] : ["h", "m"];
  const refs = React.useRef<Partial<Record<Segment, HTMLInputElement | null>>>({});
  // What is being typed into a segment before it is committed (one digit of
  // two). `null` = show the committed value.
  const [draft, setDraftState] = React.useState<{ seg: Segment; text: string } | null>(null);
  // Mirrored in a ref because a commit moves focus *inside* the same event:
  // the segment being left blurs before React re-renders, and its `onBlur`
  // would otherwise read the stale draft and commit it over the new value.
  const draftRef = React.useRef(draft);
  function setDraft(next: { seg: Segment; text: string } | null) {
    draftRef.current = next;
    setDraftState(next);
  }

  function emit(next: Record<Segment, number>) {
    onChange(
      seconds ? `${pad(next.h)}:${pad(next.m)}:${pad(next.s)}` : `${pad(next.h)}:${pad(next.m)}`,
    );
  }

  function commit(seg: Segment, n: number) {
    emit({ ...parts, [seg]: Math.min(MAX[seg], Math.max(0, n)) });
  }

  function focusSibling(seg: Segment, dir: 1 | -1) {
    const next = segments[segments.indexOf(seg) + dir];
    if (next) refs.current[next]?.focus();
  }

  function onInput(seg: Segment, raw: string) {
    const digits = raw.replace(/\D/g, "").slice(-2);
    if (!digits) {
      setDraft({ seg, text: "" });
      return;
    }
    const n = Number(digits);
    // Done with this segment: two digits typed, or one digit that no second
    // digit could follow (`3` in the hours: 30+ is out of range).
    if (digits.length === 2 || n * 10 > MAX[seg]) {
      setDraft(null);
      commit(seg, n);
      focusSibling(seg, 1);
    } else {
      setDraft({ seg, text: digits });
    }
  }

  function onBlur(seg: Segment) {
    const pending = draftRef.current;
    if (pending?.seg !== seg) return;
    if (pending.text !== "") commit(seg, Number(pending.text));
    setDraft(null);
  }

  function onKeyDown(seg: Segment, e: React.KeyboardEvent<HTMLInputElement>) {
    const span = MAX[seg] + 1;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setDraft(null);
      commit(seg, (parts[seg] + (e.key === "ArrowUp" ? 1 : -1) + span) % span);
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      e.preventDefault();
      focusSibling(seg, 1);
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      focusSibling(seg, -1);
    } else if (e.key === "Backspace" && e.currentTarget.value === "") {
      e.preventDefault();
      focusSibling(seg, -1);
    } else if (e.key === ":") {
      e.preventDefault();
      focusSibling(seg, 1);
    }
  }

  const label: Record<Segment, string> = {
    h: labels.hours,
    m: labels.minutes,
    s: labels.seconds,
  };

  return (
    <div
      role="group"
      aria-disabled={disabled || undefined}
      className={cn(
        inputVariants({ size }),
        fieldFocus("focus-within"),
        "inline-flex items-center gap-0 font-mono tabular-nums",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      onClick={(e) => {
        // A click on the box's padding lands in the first segment.
        if (e.target === e.currentTarget) refs.current.h?.focus();
      }}
    >
      {segments.map((seg, i) => (
        <React.Fragment key={seg}>
          {i > 0 && <span className="text-muted-foreground">:</span>}
          <input
            ref={(el) => {
              refs.current[seg] = el;
            }}
            type="text"
            inputMode="numeric"
            disabled={disabled}
            aria-label={label[seg]}
            role="spinbutton"
            aria-valuemin={0}
            aria-valuemax={MAX[seg]}
            aria-valuenow={parts[seg]}
            value={draft?.seg === seg ? draft.text : pad(parts[seg])}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => onInput(seg, e.target.value)}
            onBlur={() => onBlur(seg)}
            onKeyDown={(e) => onKeyDown(seg, e)}
            className="w-[2.2ch] min-w-0 rounded-sm bg-transparent p-0 text-center outline-none focus:bg-brand/15"
          />
        </React.Fragment>
      ))}
      <Clock aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0 pl-0.5 text-muted-foreground" />
    </div>
  );
}
