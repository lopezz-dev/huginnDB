/**
 * Pointer-capture drag for `Sash`, with `pointermove` coalesced to one
 * `onResize` call per animation frame.
 *
 * A drag fires `pointermove` far faster than the screen can repaint (~120Hz
 * observed), while only one panel width can ever be shown per frame anyway.
 * Calling `onResize` synchronously per event — as `Sash` used to — writes to
 * the panel-layout store, and therefore re-renders everything subscribed to
 * that width, up to twice as often as the browser could ever paint the
 * result.
 *
 * Coalescing must SUM the deltas dropped in the same frame, never discard
 * all but the last: at 60Hz a frame can only show one position, but the
 * cursor may have moved through several `pointermove` events to get there,
 * and discarding the earlier ones would make the panel edge trail behind
 * the cursor and drift further behind every frame — exactly what `Sash`'s
 * own "always 1:1 with the pointer" contract forbids. Summing keeps the
 * *total* delta correct; only how often it's flushed changes.
 *
 * Extracted out of `Sash.tsx` as a hook because it owns state (the pending
 * delta, the rAF handle) rather than merely borrowing it — see convention #28's
 * rule for when a hook is a legitimate extraction.
 */

import { useCallback, useRef } from "react";

export interface UseSashDragOptions {
  orientation: "vertical" | "horizontal";
  onResize: (delta: number) => void;
  /** Fired on drag start/end so a wrapping panel can suspend its own
   *  open/close width transition for the duration. */
  onDraggingChange?: (dragging: boolean) => void;
}

export interface SashDragHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function useSashDrag({
  orientation,
  onResize,
  onDraggingChange,
}: UseSashDragOptions): SashDragHandlers {
  const lastPos = useRef(0);
  const pendingDelta = useRef(0);
  const rafId = useRef<number | null>(null);
  // Read fresh inside the rAF callback without making it a dependency the
  // callback has to be rebuilt for on every render — the same ref-mirror
  // idea as DataGrid's `interactiveRef` (ADR #7's neighbour).
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const flush = useCallback(() => {
    rafId.current = null;
    if (pendingDelta.current === 0) return;
    const delta = pendingDelta.current;
    pendingDelta.current = 0;
    onResizeRef.current(delta);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      lastPos.current = orientation === "vertical" ? e.clientX : e.clientY;
      document.body.style.userSelect = "none";
      document.body.style.cursor =
        orientation === "vertical" ? "col-resize" : "row-resize";
      onDraggingChange?.(true);
    },
    [orientation, onDraggingChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons === 0) return;
      const pos = orientation === "vertical" ? e.clientX : e.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      if (delta === 0) return;
      pendingDelta.current += delta;
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(flush);
      }
    },
    [orientation, flush],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // A pending frame's delta must land, not be dropped on release — the
      // sash would otherwise silently lose the last few pixels of a drag
      // that happened to end just before a frame fired.
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        flush();
      }
      onDraggingChange?.(false);
    },
    [flush, onDraggingChange],
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
