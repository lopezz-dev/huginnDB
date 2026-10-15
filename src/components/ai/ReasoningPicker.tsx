/**
 * How hard the model should think, as a detent switch.
 *
 * # The design brief, and why it is a slider rather than a select
 *
 * `reasoning_effort` is an *ordered* quantity with a real trade-off at each end
 * — faster against smarter — and a dropdown states none of that. It shows six
 * words of equal weight and makes the user work out that "low" is cheaper than
 * "high" and that "auto" is not on the same axis at all. A track with discrete
 * stops carries the ordering, the direction and the current position in one
 * glance, which is the whole job.
 *
 * The register is the app's, not a new one: the dark panel chrome, `--brand` as
 * the single accent, the `xs` density, mono for the value. A control that
 * introduced its own typeface or palette inside a 360px dock panel would read
 * as a widget bolted on rather than part of the tool — and `components/ui/`'s
 * rules (convention #60) exist precisely to stop that. What is spent here is
 * precision: the fill and the knob share one easing, the stops light up in
 * order, and the trigger carries a five-bar meter so the level is legible
 * without opening anything.
 *
 * # Accessibility comes from a native control, not from ARIA
 *
 * The visible track, stops and knob are `pointer-events-none` decoration. The
 * thing that actually handles a drag, a click, Home/End and the arrow keys is
 * an ordinary `<input type="range">` lying transparent on top of them, which
 * also supplies the role, the value and the value text for free. Hand-rolling
 * that on a `<div role="slider">` is how a control ends up keyboard-hostile,
 * and the app has no Radix slider dependency to reach for.
 *
 * # Why `auto` is a switch and not the leftmost stop
 *
 * Because it is not a lower effort — it means *send no `reasoning_effort` at
 * all*, which is the only setting a strict server (OpenAI on a non-reasoning
 * model) cannot reject. Putting it on the track would imply an ordering it does
 * not have and would hide the one thing about it worth knowing. See
 * `AiReasoningEffort` in `src-tauri/src/prefs.rs`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import type { AiReasoningEffort } from "@/types";

/** The ordered stops. `auto` is deliberately not among them — see the docs. */
const LEVELS = ["none", "low", "medium", "high", "max"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Bar heights, as literal classes rather than an interpolated `h-[${n}px]`.
 *
 * Tailwind's JIT scans source as *text*, so a class assembled at runtime is
 * never generated — no error, just a bar with no height. Convention #60 records the
 * same trap for `fieldFocus`.
 */
const BAR_HEIGHTS = ["h-1", "h-1.5", "h-2", "h-2.5", "h-3"] as const;

/** The five-bar level glyph. Decoration: the label beside it carries the word. */
function EffortMeter({ level, dimmed }: { level: number; dimmed: boolean }) {
  return (
    <span className="flex items-end gap-px" aria-hidden>
      {BAR_HEIGHTS.map((height, i) => (
        <span
          key={height}
          className={cn(
            "w-0.5 rounded-full transition-colors duration-150",
            height,
            i <= level && !dimmed ? "bg-brand" : "bg-muted-foreground/35",
          )}
        />
      ))}
    </span>
  );
}

export function ReasoningPicker({
  value,
  onChange,
}: {
  value: AiReasoningEffort;
  onChange: (value: AiReasoningEffort) => void;
}) {
  const { t } = useTranslation();
  const auto = value === "auto";

  // Remembered so turning `auto` off returns to the level the user last chose
  // rather than to an arbitrary default — and so the track has something
  // truthful to show, dimmed, while `auto` is on.
  const [level, setLevel] = useState<Level>(() =>
    auto ? "medium" : (value as Level),
  );
  const index = LEVELS.indexOf(auto ? level : (value as Level));
  const pct = (index / (LEVELS.length - 1)) * 100;

  function pick(next: Level) {
    setLevel(next);
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Chrome, not a control: the composer's status row is a place to
            *read* the current state, and a bordered select there competes with
            the composer for the eye. Quiet at rest, full contrast under the
            pointer — the `quiet` variant exists for exactly this. */}
        <Button
          flat
          variant="quiet"
          size="xs"
          className="h-auto shrink-0 gap-1 px-1 py-0.5 text-2xs font-normal"
        >
          <EffortMeter level={index} dimmed={auto} />
          <span className="lowercase">
            {t(`ai.effort.level.${auto ? "auto" : value}`)}
          </span>
        </Button>
      </DropdownMenuTrigger>

      {/* `side="top"`: the trigger sits in the panel's footer, so a menu
          opening downwards would land off the bottom of the window. */}
      <DropdownMenuContent side="top" align="end" className="w-60 p-0">
        {/* Radix menus own the arrow keys for item navigation and run a
            typeahead over printable keys. Both would fight the range input
            below, which needs Left/Right and Home/End of its own — so the
            slider's keyboard events stop here rather than reaching the menu. */}
        <div
          className="space-y-2.5 px-3 py-2.5"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <span className={cn(MICRO_HEADING, "text-muted-foreground")}>
              {t("ai.effort.title")}
            </span>
            <span
              className={cn(
                "font-mono text-xs",
                auto ? "text-muted-foreground" : "text-brand",
              )}
            >
              {t(`ai.effort.level.${auto ? "auto" : value}`)}
            </span>
            <span className="ml-auto shrink-0">
              <IconButton
                size="xs"
                icon={CircleHelp}
                label={t("ai.effort.help")}
                // The documented escape hatch: a Radix tooltip inside open menu
                // content fights the menu's own hover and portal handling, so
                // in-menu help is a native title (see `ui/tooltip.tsx`).
                nativeTitle
              />
            </span>
          </div>

          <div className={cn("space-y-1.5", auto && "opacity-40")}>
            <div className="flex items-center justify-between">
              <span className="text-3xs text-muted-foreground">
                {t("ai.effort.faster")}
              </span>
              <span className="text-3xs text-muted-foreground">
                {t("ai.effort.smarter")}
              </span>
            </div>

            <div className="relative h-4">
              {/* The real control: transparent, on top, and the source of every
                  interaction and of the announced value. */}
              <input
                type="range"
                min={0}
                max={LEVELS.length - 1}
                step={1}
                value={index}
                disabled={auto}
                aria-label={t("ai.effort.title")}
                aria-valuetext={t(`ai.effort.level.${LEVELS[index]}`)}
                onChange={(e) => pick(LEVELS[Number(e.target.value)])}
                className="peer absolute inset-0 z-20 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
              />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2">
                <div className="h-0.5 rounded-full bg-muted-foreground/25" />
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-150 ease-out"
                  style={{ width: `${pct}%` }}
                />
                {LEVELS.map((stop, i) => (
                  <span
                    key={stop}
                    className={cn(
                      "absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
                      i <= index && !auto
                        ? "bg-brand"
                        : "bg-muted-foreground/40",
                    )}
                    style={{ left: `${(i / (LEVELS.length - 1)) * 100}%` }}
                  />
                ))}
                <span
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand bg-background shadow-elevation-1 transition-[left] duration-150 ease-out peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40"
                  style={{ left: `${pct}%` }}
                />
              </div>
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 border-t border-border/60 pt-2">
            <span className="min-w-0 flex-1">
              <span className="block text-2xs">{t("ai.effort.autoLabel")}</span>
              <span className="block text-3xs leading-snug text-muted-foreground">
                {t("ai.effort.autoHint")}
              </span>
            </span>
            <Switch
              checked={auto}
              onCheckedChange={(on) => onChange(on ? "auto" : level)}
              aria-label={t("ai.effort.autoLabel")}
            />
          </label>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
