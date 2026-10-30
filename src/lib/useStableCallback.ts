import { useMemo, useRef } from "react";

/**
 * A handler whose identity survives re-renders while it still calls the latest
 * `fn` — or `undefined` while `fn` is.
 *
 * For handing a parent's callbacks to `React.memo`'d children (`GridRow`)
 * when the parent declares them as plain functions with wide dependencies:
 * every render of the parent would otherwise give every child a "changed"
 * prop and the memo would fail open. Presence is kept rather than papered
 * over, because children read it — a row's context menu shows *Delete row*
 * only when `onDeleteRow` exists — so the identity changes exactly when
 * `fn` comes or goes.
 *
 * The ref is refreshed during render, the pattern `DataGrid`'s
 * `rowCallbacksRef` already uses: the proxy only ever runs from an event
 * handler, after the render that stored it has committed.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  const present = fn !== undefined;
  return useMemo(
    () => (present ? (...args: A) => ref.current!(...args) : undefined),
    [present],
  );
}
