/**
 * The app lock's padlock: an SVG drawn in the brand's sticker style — the
 * same chunky dark outline, white rim and glossy blue as the H mark, with the
 * database cylinder's steel for the shackle and its three LEDs on the body.
 *
 * It is the one animated object of the lock screen, and its phases say what
 * the backend is doing rather than decorate it:
 *
 * - `closing` — the shackle drops in with a clunk and comic impact lines; what
 *   the wall plays when it appears (on start, and after a lock reloads the
 *   window into it).
 * - `locked`  — at rest, LEDs dim, a slow float.
 * - `checking` — the LEDs chase while Argon2 runs.
 * - `wrong`   — a shake and a red flash.
 * - `waiting` — amber LEDs, and a ring that drains over `waitMs`.
 * - `opening` — the shackle springs up and swings open, green LEDs, a burst.
 * - `open`    — at rest, open (Settings, with the lock off).
 * - `broken`  — red LEDs, still: the vault cannot be opened.
 *
 * Pure CSS on SVG (`lock.css`): no animation library, and
 * `prefers-reduced-motion` keeps every state but drops the movement.
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import "./lock.css";

export type PadlockPhase =
  | "closing"
  | "locked"
  | "checking"
  | "wrong"
  | "waiting"
  | "opening"
  | "open"
  | "broken";

export function Padlock({
  phase,
  waitMs = 0,
  className,
}: {
  phase: PadlockPhase;
  /** How long the `waiting` ring takes to drain. */
  waitMs?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 240 260"
      role="img"
      aria-hidden
      data-phase={phase}
      className={cn("padlock", className)}
      style={{ "--padlock-wait": `${Math.max(waitMs, 1)}ms` } as CSSProperties}
    >
      <defs>
        <linearGradient id="padlock-body" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#6aa4ff" />
          <stop offset="0.45" stopColor="#2f6ff0" />
          <stop offset="1" stopColor="#173fae" />
        </linearGradient>
        <linearGradient id="padlock-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8d9bb5" />
          <stop offset="0.35" stopColor="#e3eaf6" />
          <stop offset="0.7" stopColor="#b3c0d6" />
          <stop offset="1" stopColor="#7c8aa6" />
        </linearGradient>
        <radialGradient id="padlock-led" cx="0.35" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The waiting ring: drains over --padlock-wait. */}
      <circle className="padlock-ring" cx="120" cy="160" r="128" pathLength={100} />

      {/* Comic impact lines, flashed when the shackle lands. */}
      <g className="padlock-impact" strokeLinecap="round">
        <path d="M22 120 L6 112" />
        <path d="M24 158 L6 160" />
        <path d="M34 192 L18 204" />
        <path d="M218 120 L234 112" />
        <path d="M216 158 L234 160" />
        <path d="M206 192 L222 204" />
      </g>

      {/* The burst when it opens: four-point sparkles. */}
      <g className="padlock-sparks">
        <path d="M44 62 l5 13 13 5 -13 5 -5 13 -5 -13 -13 -5 13 -5z" />
        <path d="M196 56 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z" />
        <path d="M206 210 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" />
        <path d="M30 214 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" />
      </g>

      <g className="padlock-float">
        <g className="padlock-shake">
          {/* Shackle, drawn as stacked strokes: sticker rim, outline, steel,
              shine. Pivots on its right leg to swing open. */}
          <g className="padlock-shackle">
            <path className="padlock-shackle-rim" d="M78 132 V86 a42 42 0 0 1 84 0 V132" />
            <path className="padlock-shackle-line" d="M78 132 V86 a42 42 0 0 1 84 0 V132" />
            <path className="padlock-shackle-steel" d="M78 132 V86 a42 42 0 0 1 84 0 V132" />
            <path className="padlock-shackle-shine" d="M86 120 V88 a34 34 0 0 1 26 -33" />
          </g>

          {/* Body. */}
          <g className="padlock-body">
            <rect className="padlock-body-rim" x="40" y="118" width="160" height="118" rx="28" />
            <rect
              x="40"
              y="118"
              width="160"
              height="118"
              rx="28"
              fill="url(#padlock-body)"
              className="padlock-body-fill"
            />
            {/* The band, like the cylinder's rings. */}
            <path className="padlock-band" d="M44 196 H196" />
            {/* Gloss. */}
            <path
              className="padlock-gloss"
              d="M58 134 h70 a6 6 0 0 1 0 12 h-58 a8 8 0 0 0 -8 8 v18 a6 6 0 0 1 -12 0 v-26 a12 12 0 0 1 8 -12z"
            />
            {/* Keyhole. */}
            <g className="padlock-keyhole">
              <circle cx="120" cy="158" r="13" />
              <path d="M113 164 h14 l5 24 h-24z" />
            </g>
            {/* The three LEDs. */}
            <g className="padlock-leds">
              <circle className="padlock-led padlock-led-1" cx="92" cy="216" r="7" />
              <circle className="padlock-led padlock-led-2" cx="120" cy="216" r="7" />
              <circle className="padlock-led padlock-led-3" cx="148" cy="216" r="7" />
              <circle cx="92" cy="216" r="7" fill="url(#padlock-led)" />
              <circle cx="120" cy="216" r="7" fill="url(#padlock-led)" />
              <circle cx="148" cy="216" r="7" fill="url(#padlock-led)" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
