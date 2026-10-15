/**
 * "Is this table the active tab?" / "is this table open in any tab?", as one
 * derivation over `useTabs` instead of two per-row selectors.
 *
 * `SchemaTableRow` used to call `useTabs((s) => s.tabs.find(...))` and
 * `useTabs((s) => s.tabs.some(...))` itself — each one an O(tabs) scan.
 * Both selectors return a primitive (a string key / a boolean), so neither
 * one breaks gotcha #1 on its own, and neither one re-renders a
 * row that isn't affected. What they don't avoid is *running*: 500 rows ×
 * two O(tabs) scans is 1,000 iterations on every `useTabs` write — and
 * `updateQuery` (typing in the SQL editor) is exactly such a write, once per
 * keystroke.
 *
 * `useOpenTableKeys` computes both answers in a single pass over `tabs`,
 * called once per render of whichever explorer renders the table list — not
 * once per row — and hands down a `Set<string>` (`openTableKeys`) rows
 * check with `.has()` instead of scanning `tabs` themselves. The set is a
 * *new* reference whenever `tabs` changes, but that's fine: it's rebuilt
 * once regardless of row count, and a table row's own membership check
 * (`openTableKeys.has(tableTabKey(...))`) is what actually feeds each row's
 * `memo()` — as long as that key's membership hasn't flipped, the row's own
 * `isOpen`/`isActive` props stay the same primitive booleans they were,
 * which is what lets `TableRow`'s memo (convention #28) keep bailing
 * out for every row except the one that actually changed.
 */

import { useMemo } from "react";
import { useTabs } from "@/stores/session/tabs";
import type { AppTab } from "@/types";

/** `\0`-separated so no schema/table name can collide with the delimiter —
 *  written as the escape, never a literal NUL byte (that made the whole
 *  file binary to git once already: no diff, no review, no grep). */
export function tableTabKey(
  connectionId: string,
  schema: string | undefined,
  table: string,
): string {
  return `${connectionId}\0${schema ?? ""}\0${table}`;
}

export interface OpenTableKeys {
  /** Key of the currently-ACTIVE table tab, or `null` if the active tab
   *  isn't a table (or there is none). */
  activeTableKey: string | null;
  /** Keys of every table open in SOME tab, active or not. */
  openTableKeys: ReadonlySet<string>;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Pure reducer over `tabs`/`activeId` — the hook below is just this plus
 *  the `useTabs` subscription and the `useMemo` cache. */
export function computeOpenTableKeys(
  tabs: readonly AppTab[],
  activeId: string | null,
): OpenTableKeys {
  let activeTableKey: string | null = null;
  const openTableKeys = new Set<string>();
  for (const tab of tabs) {
    // `table` is optional on `AppTab` generically (other tab kinds don't
    // carry it), but always set in practice for `kind: "table"` — the
    // `continue` guard just keeps the compiler honest without changing
    // observed behavior.
    if (tab.kind !== "table" || tab.table === undefined) continue;
    const key = tableTabKey(tab.connectionId, tab.schema, tab.table);
    openTableKeys.add(key);
    if (tab.id === activeId) activeTableKey = key;
  }
  return {
    activeTableKey,
    openTableKeys: openTableKeys.size > 0 ? openTableKeys : EMPTY_KEYS,
  };
}

export function useOpenTableKeys(): OpenTableKeys {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  return useMemo(() => computeOpenTableKeys(tabs, activeId), [tabs, activeId]);
}
