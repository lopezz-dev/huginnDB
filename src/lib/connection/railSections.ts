/**
 * How the connection manager's rail lays out its rows: provenance first, then
 * the free-text `group` folders inside it.
 *
 * The rail has two independent grouping axes and they nest in one order only.
 * `group` is a folder the user (or, for a shared profile, the *publisher*) typed;
 * provenance is where the profile came from. A "Producción" the user made and a
 * "Producción" some shared file publishes are not the same folder, and
 * `bucketByGroup` alone would merge them under one header — which is the exact
 * ambiguity this module exists to remove. So provenance wins, and
 * `bucketByGroup` runs on each subset.
 *
 * Only the `shared` scope actually splits: `all` and `local` come back as ONE
 * headerless section, so their layout is byte-for-byte what the rail rendered
 * before this existed. A single origin doesn't need a header either, but it gets
 * one anyway — the header is where the row count and the read-only note live,
 * and hiding it for N=1 would make the rail change shape as origins are added.
 *
 * Pure on purpose: the i18n strings arrive as parameters, so the whole layout is
 * testable without a `t`. Same criterion as "the backend never writes display
 * copy" (ADR #27).
 */

import { bucketByGroup } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

import { filterByScope, originIdOf, type ProfileScope } from "./origin";

export interface RailSection {
  /** `null` for the headerless section the `all` / `local` scopes produce. */
  originId: string | null;
  /** Resolved header text, or `null` when there is no header. */
  label: string | null;
  /**
   * True for a section of profiles a shared origin publishes: no row
   * checkboxes, no select-all, no delete. Not a styling flag — it is the
   * structural half of the deletion guard, so the affordances can't exist to
   * be clicked (the backend refuses these ids as well).
   */
  readOnly: boolean;
  /**
   * Every profile id in the section, in render order, **including the ones
   * inside collapsed groups** — the domain of "select all in this section".
   *
   * Deliberately not the same list as the rail's `visibleIds`, which skips
   * collapsed groups because it is the domain of Shift-range selection. Using
   * one list for both makes select-all silently miss whatever is folded.
   */
  ids: string[];
  ungrouped: ConnectionProfile[];
  groups: Array<{ name: string; items: ConnectionProfile[] }>;
}

/**
 * Build the rail's sections for one scope.
 *
 * `profiles` is expected to be already narrowed by the search box; `scope` is
 * applied here so the caller can't forget it. `nameOf` resolves an origin id to
 * its registered name and returns `null` for an origin that has been
 * unregistered — those profiles keep a dangling `origin_id` (that is what
 * `useOriginSync.reconcileOrphans` reports on) and land in one trailing section
 * labelled with `labels.orphaned`. Filing them under "local" would be a lie:
 * they are still read-only, because the tag is what gates that.
 */
export function buildRailSections(
  profiles: ConnectionProfile[],
  scope: ProfileScope,
  nameOf: (originId: string) => string | null,
  labels: { shared: (origin: string) => string; orphaned: string },
): RailSection[] {
  const inScope = filterByScope(profiles, scope);
  if (inScope.length === 0) return [];

  if (scope !== "shared") {
    return [section(null, null, false, inScope)];
  }

  const byOrigin = new Map<string, ConnectionProfile[]>();
  const orphaned: ConnectionProfile[] = [];
  for (const p of inScope) {
    const id = originIdOf(p);
    // `filterByScope("shared")` guarantees an id, but narrow it anyway rather
    // than asserting — a null here would silently vanish from the rail.
    if (!id) continue;
    if (nameOf(id) === null) {
      orphaned.push(p);
      continue;
    }
    const list = byOrigin.get(id) ?? [];
    list.push(p);
    byOrigin.set(id, list);
  }

  const sections = Array.from(byOrigin.entries())
    .map(([id, items]) => ({ id, name: nameOf(id) ?? id, items }))
    // Sorted by the name the user reads, with the id as the tie-break so two
    // origins sharing a name still have a stable order between renders.
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((o) => section(o.id, labels.shared(o.name), true, o.items));

  if (orphaned.length > 0) {
    sections.push(section(null, labels.orphaned, true, orphaned));
  }
  return sections;
}

function section(
  originId: string | null,
  label: string | null,
  readOnly: boolean,
  items: ConnectionProfile[],
): RailSection {
  const { ungrouped, groups } = bucketByGroup(items);
  return {
    originId,
    label,
    readOnly,
    // Render order: ungrouped rows first, then each group's rows — the order
    // the rail paints them in, so a Shift-range and a select-all agree about
    // what "the rows between these two" means.
    ids: [...ungrouped, ...groups.flatMap((g) => g.items)].map((p) => p.id),
    ungrouped,
    groups,
  };
}
