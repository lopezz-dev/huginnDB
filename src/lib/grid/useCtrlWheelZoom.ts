/**
 * Ctrl + mouse-wheel over the grid zooms the rows in/out, like a code editor.
 *
 * Bound as a **non-passive native listener** so `preventDefault` actually
 * suppresses the browser's page zoom — a JSX `onWheel` is passive by default and
 * cannot (ADR #13). Persistence is the prefs store's job (it
 * debounces the write), so this only pushes the clamped row height.
 *
 * Returns the ref to attach to the scroll container; the grid needs that ref for
 * other things too, so it is handed back rather than taken as a parameter.
 */

import { useEffect, useRef } from "react";

import { clampRowHeight } from "@/lib/grid/rowHeight";

export function useCtrlWheelZoom(
  rowHeight: number,
  updateGrid: (patch: { rowHeight: number }) => void,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 2 : -2;
      const next = clampRowHeight(rowHeight + step);
      if (next !== rowHeight) updateGrid({ rowHeight: next });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rowHeight, updateGrid]);

  return scrollRef;
}
