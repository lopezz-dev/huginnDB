/**
 * Launch splash — the one screen in the app that is allowed to be pure brand:
 * the sticker mark, large, over a halftone wash and a blue bloom on the dark
 * (or light) app surface. Per the visual brief it must be *brief*, so it is on
 * screen for roughly a third of a second and then fades out over another fifth.
 *
 * Deliberately NOT a second Tauri window: a real splash window would have to be
 * created, positioned and closed around webview startup (and on Windows that
 * means an `async fn` command building a `WebviewWindow` — see gotcha #19),
 * which is a lot of moving parts for half a second of paint. This is a plain
 * overlay inside the existing window, mounted at the top of the app tree.
 *
 * It is also intentionally decoupled from the launch sequence (reconnect →
 * layout → focus, ADRs #8 and #10): it neither waits for it nor blocks it.
 * Gating a purely decorative overlay on session restore would mean a slow
 * reconnect keeps the user staring at a logo, and a failure could leave the
 * overlay up forever. It runs on its own timer and gets out of the way.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Time the mark is fully opaque before the fade begins. */
const HOLD_MS = 340;
/** Fade duration — the top of the brand motion band (150–220ms). */
const FADE_MS = 220;

export function SplashScreen() {
  const [phase, setPhase] = useState<"hold" | "fading" | "done">("hold");

  useEffect(() => {
    const fade = window.setTimeout(() => setPhase("fading"), HOLD_MS);
    const done = window.setTimeout(() => setPhase("done"), HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
    };
  }, []);

  if (phase === "done") return null;

  return (
    <div
      aria-hidden
      className={cn(
        // `pointer-events-none` from the very first frame: the app underneath is
        // already interactive, and a decorative overlay must never eat a click
        // from someone who types faster than the animation.
        "pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity ease-out",
        phase === "fading" ? "opacity-0 duration-220" : "opacity-100 duration-0",
      )}
    >
      {/* Coarser pitch than a medallion's, same as the empty workspace: this
          field covers the entire window. */}
      <span
        aria-hidden
        className="halftone-centered absolute inset-0 [--halftone-pitch:14px]"
      />
      <span
        aria-hidden
        className="absolute h-72 w-72 rounded-full bg-brand/20 blur-[90px]"
      />
      <img
        src="/image/huginn-mark-512.png"
        alt=""
        width={512}
        height={512}
        className="relative h-40 w-40 select-none animate-pop-in drop-shadow-[0_8px_32px_color-mix(in_srgb,var(--brand)_35%,transparent)]"
        draggable={false}
      />
    </div>
  );
}
