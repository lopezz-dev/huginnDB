/**
 * Registry mapping an open `kind: "table"` tab id to its own reload
 * function (the same one wired to its toolbar refresh button).
 *
 * Exists so the global F5 / Ctrl+R interceptor in `App.tsx` can trigger a
 * specific table tab's reload without threading a callback down through
 * the dockview panel tree — the same "registry populated on mount, cleared
 * on unmount" shape used for the Monaco SQL providers (see gotcha #9
 * / `src/lib/monacoSql.ts`).
 */

const registry = new Map<string, () => void>();

/** Register `tabId`'s reload function. Call again if the function's
 *  identity changes (e.g. it closes over a new `connectionId`). */
export function registerTableRefresh(tabId: string, fn: () => void): void {
  registry.set(tabId, fn);
}

/** Remove `tabId`'s registration. Call on unmount. */
export function unregisterTableRefresh(tabId: string): void {
  registry.delete(tabId);
}

/** Trigger `tabId`'s reload if it is currently registered. Returns whether
 *  a handler was found and invoked. */
export function refreshTable(tabId: string): boolean {
  const fn = registry.get(tabId);
  if (!fn) return false;
  fn();
  return true;
}
